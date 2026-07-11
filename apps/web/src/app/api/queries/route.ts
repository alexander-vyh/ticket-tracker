import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { isAggregatorSource } from '@/lib/scraper/navigate';
import { getClientIp } from '@/lib/trusted-ip';
import { redis } from '@/lib/redis';
import { safeHttpUrl } from '@/lib/safe-url';
import { isValidPriceAmount } from '@/lib/limits';

class PaxValidationError extends Error {}

/**
 * Validate and normalize an optional multi-segment itinerary and derive its
 * trip shape. Mirrors the tfs-builder's rules so an itinerary that persists
 * here is one the data plane can actually encode:
 *   - 2 legs whose return reverses the outbound  → round_trip
 *   - 2 legs whose return does NOT reverse it     → open_jaw
 *   - 3+ legs                                     → multi_city
 * Throws PaxValidationError (→ 400) on any malformed input.
 */
function parseSegments(
  raw: unknown,
): { segments: Array<{ from: string; to: string; date: string }>; tripType: string } {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new PaxValidationError('segments must be an array of at least 2 legs');
  }
  if (raw.length > 6) {
    throw new PaxValidationError('segments supports at most 6 legs');
  }
  const iata = /^[A-Za-z]{3}$/;
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const segments = raw.map((leg, i): { from: string; to: string; date: string } => {
    if (typeof leg !== 'object' || leg === null) {
      throw new PaxValidationError(`segment ${i} must be an object with from/to/date`);
    }
    const { from, to, date } = leg as Record<string, unknown>;
    if (typeof from !== 'string' || !iata.test(from)) {
      throw new PaxValidationError(`segment ${i}: 'from' must be a 3-letter airport code`);
    }
    if (typeof to !== 'string' || !iata.test(to)) {
      throw new PaxValidationError(`segment ${i}: 'to' must be a 3-letter airport code`);
    }
    if (typeof date !== 'string' || !isoDate.test(date)) {
      throw new PaxValidationError(`segment ${i}: 'date' must be YYYY-MM-DD`);
    }
    if (from.toUpperCase() === to.toUpperCase()) {
      throw new PaxValidationError(`segment ${i}: 'from' and 'to' must differ`);
    }
    return { from: from.toUpperCase(), to: to.toUpperCase(), date };
  });
  let tripType: string;
  if (segments.length === 2) {
    const [out, ret] = segments;
    const reverses = out!.from === ret!.to && out!.to === ret!.from;
    tripType = reverses ? 'round_trip' : 'open_jaw';
  } else {
    tripType = 'multi_city';
  }
  return { segments, tripType };
}

const MAX_ROUTES = 20;
const MAX_FLIGHTS_PER_ROUTE = 50;

// Per-IP creation rate limit: 20 new tracked queries per 10 minutes.
// This bounds the Playwright and LLM fan-out an unauthenticated caller
// can trigger from a single IP address.
const CREATE_RATE_LIMIT = 20;
const CREATE_RATE_TTL_SECONDS = 10 * 60;
const RATE_KEY_PREFIX = 'queries-create:';

// Field length caps
const MAX_RAW_INPUT = 500;
const MAX_NAME_LENGTH = 200;
const MAX_AIRLINE_LENGTH = 100;
const MAX_FLIGHT_NUMBER_LENGTH = 20;
const MAX_URL_LENGTH = 2048;
const MAX_DURATION_LENGTH = 20;
const MAX_CURRENCY_LENGTH = 3;

// Numeric field bounds
const MAX_STOPS_VALUE = 10;

interface RouteInput {
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  date?: string; // when set, pins this query to a specific outbound date
  returnDate?: string; // when set, pins return date for round trips
  selectedFlights: Array<{
    travelDate: string;
    price: number;
    currency?: string;
    airline: string;
    bookingUrl: string | null;
    stops?: number;
    duration?: string | null;
    flightNumber?: string | null;
  }>;
}

/**
 * Strict YYYY-MM-DD validation that round-trips the parsed parts, so an invalid
 * calendar date like 2026-02-31 (which `new Date()` silently rolls over to March)
 * and any non-date-only format are rejected before persistence.
 */
function isValidDateString(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export async function POST(request: NextRequest) {
  // Per-IP rate limit check before any expensive auth or DB work
  const ip = getClientIp(request);
  if (redis) {
    try {
      const rateKey = `${RATE_KEY_PREFIX}${ip}`;
      const count = await redis.incr(rateKey);
      if (count === 1) {
        await redis.expire(rateKey, CREATE_RATE_TTL_SECONDS);
      }
      if (count > CREATE_RATE_LIMIT) {
        const ttl = await redis.ttl(rateKey);
        return new Response(
          JSON.stringify({ ok: false, error: 'Too many tracker requests; try again later' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(ttl > 0 ? ttl : CREATE_RATE_TTL_SECONDS),
            },
          },
        );
      }
    } catch {
      // Fail open: Redis unavailable should not block query creation
    }
  }

  const multiUser = await isMultiUserEnabled();
  const currentUser = multiUser ? await getCurrentUser() : null;
  if (multiUser && !currentUser) {
    return apiError('Sign in to create a tracker', 401);
  }

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const {
    rawInput,
    dateFrom,
    dateTo,
    flexibility,
    maxPrice,
    maxStops,
    maxDurationHours,
    preferredAirlines,
    timePreference,
    cabinClass,
    tripType,
    currency: bodyCurrency,
    vpnCountries: bodyVpnCountries,
    adults: bodyAdults,
    children: bodyChildren,
    infantsInSeat: bodyInfantsInSeat,
    infantsOnLap: bodyInfantsOnLap,
    segments: bodySegments,
  } = body;

  // Validate rawInput length
  if (typeof rawInput === 'string' && rawInput.length > MAX_RAW_INPUT) {
    return apiError(`rawInput must be ${MAX_RAW_INPUT} characters or fewer`, 400);
  }

  const currency: string | null = typeof bodyCurrency === 'string' && bodyCurrency ? bodyCurrency : null;
  // Passenger counts: same invariants tfs-builder enforces (Google's 9-pax
  // hard limit; airlines require one adult per lap infant). Absent fields
  // default to the pre-passengers behavior: one adult.
  const paxField = (v: unknown, name: string, min: number): number => {
    if (v === undefined || v === null) return min;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > 9) {
      throw new PaxValidationError(`${name} must be an integer between ${min} and 9`);
    }
    return v;
  };
  let adults: number, children: number, infantsInSeat: number, infantsOnLap: number;
  try {
    adults = paxField(bodyAdults, 'adults', bodyAdults === undefined ? 1 : 1);
    children = paxField(bodyChildren, 'children', 0);
    infantsInSeat = paxField(bodyInfantsInSeat, 'infantsInSeat', 0);
    infantsOnLap = paxField(bodyInfantsOnLap, 'infantsOnLap', 0);
  } catch (err) {
    if (err instanceof PaxValidationError) return apiError(err.message, 400);
    throw err;
  }
  const totalPax = adults + children + infantsInSeat + infantsOnLap;
  if (totalPax > 9) {
    return apiError('Too many passengers: Google Flights supports at most 9', 400);
  }
  if (infantsOnLap > adults) {
    return apiError('Each infant on lap requires an adult', 400);
  }

  // Optional multi-segment itinerary (open-jaw / multi-city). When present it is
  // the source of truth for the trip shape; absent = a single-pair itinerary
  // described by origin/destination/dateFrom/dateTo (unchanged legacy behavior).
  let segments: Array<{ from: string; to: string; date: string }> | null = null;
  let itineraryTripType: string | null = null;
  if (bodySegments !== undefined && bodySegments !== null) {
    try {
      ({ segments, tripType: itineraryTripType } = parseSegments(bodySegments));
    } catch (err) {
      if (err instanceof PaxValidationError) return apiError(err.message, 400);
      throw err;
    }
  }


  if (currency !== null && currency.length > MAX_CURRENCY_LENGTH) {
    return apiError(`currency must be ${MAX_CURRENCY_LENGTH} characters or fewer`, 400);
  }

  // Validate maxDurationHours: integer between 1 and 48 hours, or null.
  let maxDurationHoursValidated: number | null = null;
  if (maxDurationHours !== undefined && maxDurationHours !== null) {
    const n = Number(maxDurationHours);
    if (!Number.isInteger(n) || n < 1 || n > 48) {
      return apiError('maxDurationHours must be an integer between 1 and 48', 400);
    }
    maxDurationHoursValidated = n;
  }

  // Validate maxPrice: finite non-negative number within sane range, or null.
  let maxPriceValidated: number | null = null;
  if (maxPrice !== undefined && maxPrice !== null) {
    const n = Number(maxPrice);
    if (!isValidPriceAmount(n)) {
      return apiError('maxPrice must be a finite non-negative number', 400);
    }
    maxPriceValidated = n;
  }

  // Validate maxStops: integer 0-10 or null.
  let maxStopsValidated: number | null = null;
  if (maxStops !== undefined && maxStops !== null) {
    const n = Number(maxStops);
    if (!Number.isInteger(n) || n < 0 || n > MAX_STOPS_VALUE) {
      return apiError(`maxStops must be an integer between 0 and ${MAX_STOPS_VALUE}`, 400);
    }
    maxStopsValidated = n;
  }

  const vpnCountries: string[] = Array.isArray(bodyVpnCountries)
    ? bodyVpnCountries.filter((c: unknown) => typeof c === 'string' && /^[A-Z]{2}$/.test(c))
    : [];

  // Support both new (routes array) and legacy (single origin/destination) formats
  let routeInputs: RouteInput[];

  if (Array.isArray(body.routes) && body.routes.length > 0) {
    routeInputs = body.routes;
  } else if (body.origin && body.destination) {
    // Legacy single-route format
    routeInputs = [{
      origin: body.origin,
      originName: body.originName || body.origin,
      destination: body.destination,
      destinationName: body.destinationName || body.destination,
      selectedFlights: Array.isArray(body.selectedFlights) ? body.selectedFlights : [],
    }];
  } else {
    return apiError('Missing required fields: routes array or origin/destination', 400);
  }

  if (!rawInput || !dateFrom || !dateTo) {
    return apiError('Missing required fields: rawInput, dateFrom, dateTo', 400);
  }

  if (routeInputs.length > MAX_ROUTES) {
    return apiError(`Too many routes: maximum is ${MAX_ROUTES}`, 400);
  }

  // Validate all route fields: airport codes, name lengths, per-route flight counts, and flight fields
  for (const route of routeInputs) {
    if (!/^[A-Z]{3}$/.test(route.origin) || !/^[A-Z]{3}$/.test(route.destination)) {
      return apiError(`Invalid airport code in route ${route.origin}--${route.destination}`, 400);
    }

    if (typeof route.originName === 'string' && route.originName.length > MAX_NAME_LENGTH) {
      return apiError(`originName must be ${MAX_NAME_LENGTH} characters or fewer`, 400);
    }
    if (typeof route.destinationName === 'string' && route.destinationName.length > MAX_NAME_LENGTH) {
      return apiError(`destinationName must be ${MAX_NAME_LENGTH} characters or fewer`, 400);
    }

    if (route.date !== undefined && !isValidDateString(route.date)) {
      return apiError(`Route date is not a valid date: ${route.date}`, 400);
    }
    if (route.returnDate !== undefined && !isValidDateString(route.returnDate)) {
      return apiError(`Route returnDate is not a valid date: ${route.returnDate}`, 400);
    }

    const flights = route.selectedFlights ?? [];
    if (flights.length > MAX_FLIGHTS_PER_ROUTE) {
      return apiError(
        `Too many flights for route ${route.origin}--${route.destination}: maximum is ${MAX_FLIGHTS_PER_ROUTE}`,
        400
      );
    }

    for (const f of flights) {
      if (!isValidDateString(f.travelDate)) {
        return apiError(`Selected flight has invalid travelDate: ${f.travelDate}`, 400);
      }

      const price = Number(f.price);
      if (!isValidPriceAmount(price)) {
        return apiError('Selected flight price must be a finite non-negative number', 400);
      }

      if (typeof f.airline === 'string' && f.airline.length > MAX_AIRLINE_LENGTH) {
        return apiError(`Selected flight airline must be ${MAX_AIRLINE_LENGTH} characters or fewer`, 400);
      }

      if (f.flightNumber !== undefined && f.flightNumber !== null) {
        if (typeof f.flightNumber === 'string' && f.flightNumber.length > MAX_FLIGHT_NUMBER_LENGTH) {
          return apiError(`Selected flight flightNumber must be ${MAX_FLIGHT_NUMBER_LENGTH} characters or fewer`, 400);
        }
      }

      if (f.duration !== undefined && f.duration !== null) {
        if (typeof f.duration === 'string' && f.duration.length > MAX_DURATION_LENGTH) {
          return apiError(`Selected flight duration must be ${MAX_DURATION_LENGTH} characters or fewer`, 400);
        }
      }

      if (f.bookingUrl !== null && f.bookingUrl !== undefined) {
        if (typeof f.bookingUrl === 'string' && f.bookingUrl.length > MAX_URL_LENGTH) {
          return apiError(`Selected flight bookingUrl must be ${MAX_URL_LENGTH} characters or fewer`, 400);
        }
      }

      if (f.stops !== undefined && f.stops !== null) {
        const stops = Number(f.stops);
        if (!Number.isInteger(stops) || stops < 0 || stops > MAX_STOPS_VALUE) {
          return apiError(`Selected flight stops must be an integer between 0 and ${MAX_STOPS_VALUE}`, 400);
        }
      }
    }
  }

  // Validate preferredAirlines entry lengths
  const airlines: string[] = Array.isArray(preferredAirlines)
    ? preferredAirlines.filter((a: unknown) => typeof a === 'string')
    : [];
  for (const a of airlines) {
    if (a.length > MAX_AIRLINE_LENGTH) {
      return apiError(`preferredAirlines entry must be ${MAX_AIRLINE_LENGTH} characters or fewer`, 400);
    }
  }

  // Validate vpnCountries entry lengths (already filtered to 2-char uppercase, no extra check needed)

  if (!isValidDateString(dateFrom) || !isValidDateString(dateTo)) {
    return apiError('Invalid date format (expected YYYY-MM-DD)', 400);
  }
  const from = new Date(dateFrom + 'T00:00:00Z');
  const to = new Date(dateTo + 'T00:00:00Z');

  const isOneWay = tripType === 'one_way';
  if (!isOneWay && from >= to) {
    return apiError('dateFrom must be before dateTo', 400);
  }

  const flex = Math.max(0, Math.min(Number(flexibility) || 0, 14));
  const expiresAt = new Date(to);
  expiresAt.setDate(expiresAt.getDate() + flex);

  // preferredAggregators is optional on creation; empty means inherit user/admin defaults.
  let aggregators: string[] = [];
  if (Array.isArray(body.preferredAggregators)) {
    for (const a of body.preferredAggregators) {
      if (!isAggregatorSource(a)) {
        return apiError(`preferredAggregators contains invalid value: ${JSON.stringify(a)}`, 422);
      }
    }
    aggregators = body.preferredAggregators;
  }

  let label: string | null = null;
  if (typeof body.label === 'string') {
    const trimmed = body.label.trim();
    if (trimmed.length > 60) {
      return apiError('label must be 60 characters or fewer', 400);
    }
    label = trimmed || null;
  }

  const groupId = crypto.randomUUID();

  const results: Array<{
    id: string;
    origin: string;
    originName: string;
    destination: string;
    destinationName: string;
    date?: string;
    returnDate?: string;
    deleteToken: string;
    label: string | null;
  }> = [];

  for (const route of routeInputs) {
    const flights = route.selectedFlights || [];

    const deleteToken = crypto.randomUUID();

    // Per-date pinning: when route has a specific date, pin dateFrom to outbound and dateTo to return
    const routeFrom = route.date ? new Date(route.date + 'T00:00:00Z') : from;
    const routeTo = route.returnDate ? new Date(route.returnDate + 'T00:00:00Z') : (route.date ? new Date(route.date + 'T00:00:00Z') : to);
    const routeFlex = route.date ? 0 : flex;
    const routeExpiry = new Date(routeTo);
    routeExpiry.setDate(routeExpiry.getDate() + routeFlex);

    const query = await prisma.query.create({
      data: {
        rawInput,
        origin: route.origin,
        originName: route.originName,
        destination: route.destination,
        destinationName: route.destinationName,
        dateFrom: routeFrom,
        dateTo: routeTo,
        flexibility: routeFlex,
        maxPrice: maxPriceValidated,
        maxStops: maxStopsValidated,
        maxDurationHours: maxDurationHoursValidated,
        preferredAirlines: airlines,
        preferredAggregators: aggregators,
        label,
        timePreference: timePreference || 'any',
        cabinClass: cabinClass || 'economy',
        tripType: itineraryTripType
          ?? (tripType === 'one_way' ? 'one_way' : 'round_trip'),
        segments: segments ?? undefined,
        adults,
        children,
        infantsInSeat,
        infantsOnLap,
        currency,
        vpnCountries,
        expiresAt: routeExpiry,
        firstViewedAt: new Date(),
        deleteToken,
        groupId,
        userId: currentUser?.id ?? null,
      },
    });

    if (flights.length > 0) {
      await prisma.priceSnapshot.createMany({
        data: flights.map((f) => ({
          queryId: query.id,
          travelDate: new Date(f.travelDate + 'T00:00:00Z'),
          // Store the coerced numeric values (validated above), not the raw
          // input, so a numeric string like "300" cannot reach Prisma as a string.
          price: Number(f.price),
          currency: f.currency || 'USD',
          airline: f.airline,
          // safeHttpUrl drops non-http(s) URLs to prevent javascript:/data:/file: injection
          bookingUrl: safeHttpUrl(f.bookingUrl) || '',
          stops: f.stops != null ? Number(f.stops) : 0,
          duration: f.duration ?? null,
          flightNumber: f.flightNumber ?? null,
        })),
      });
    }

    results.push({
      id: query.id,
      origin: route.origin,
      originName: route.originName,
      destination: route.destination,
      destinationName: route.destinationName,
      date: route.date,
      returnDate: route.returnDate,
      deleteToken,
      label,
    });
  }

  // Fire immediate scrape for all created queries including VPN passes (background, non-blocking)
  const { runFullScrapeForQuery } = await import('@/lib/scraper/run-scrape');
  for (const q of results) {
    runFullScrapeForQuery(q.id).catch((err) => {
      console.error(`[queries] background scrape failed for ${q.id}:`, err instanceof Error ? err.message : err);
    });
  }

  return apiSuccess({ queries: results }, 201);
}
