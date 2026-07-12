/**
 * POST /api/variation/search — run a variation sweep (ticket-tracker-izy).
 *
 * Prices a NEIGHBOURHOOD of itineraries (depart window x return window x stay
 * length x NZ gateways x route shape) and returns the matrix plus the cheapest
 * bookable cell. This is the tracker's core question — "where CAN we fly, and
 * where is it cheapest?" — rather than "what does this one fixed trip cost?".
 *
 * The sweep is expensive (each cell is a real Google query), so it is bounded on
 * two independent axes and BOTH are reported back:
 *   - maxCombos    — the grid cap (evenly sampled, so it still spans the window)
 *   - requestBudget — the hard ceiling on pricing requests
 * A caller must be able to tell a complete sweep from a partial one.
 */
import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { runVariationSearch, type PartyPassengers } from '@/lib/variation/search';
import { createDataplanePricer } from '@/lib/variation/pricer';
import type { RouteShape, VariationSpec } from '@/lib/variation/grid';
import { getCountryProfile } from '@/lib/scraper/country-profiles';
import { prisma } from '@/lib/prisma';

class SpecValidationError extends Error {}

const SHAPES: readonly RouteShape[] = ['round_trip', 'open_jaw', 'two_one_ways'];
const IATA = /^[A-Z]{3}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Hard ceilings so one request cannot melt the browser tier or Google's patience. */
const MAX_COMBOS_CEILING = 60;
const MAX_REQUEST_BUDGET = 40;

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new SpecValidationError(`${field} is required`);
  }
  return v;
}

function airport(v: unknown, field: string): string {
  const s = str(v, field).toUpperCase();
  if (!IATA.test(s)) throw new SpecValidationError(`${field} must be a 3-letter airport code`);
  return s;
}

function day(v: unknown, field: string): string {
  const s = str(v, field);
  if (!ISO_DAY.test(s)) throw new SpecValidationError(`${field} must be YYYY-MM-DD`);
  return s;
}

function window(raw: unknown, field: string): { from: string; to: string } {
  if (!raw || typeof raw !== 'object') {
    throw new SpecValidationError(`${field} must be {from,to}`);
  }
  const w = raw as { from?: unknown; to?: unknown };
  const from = day(w.from, `${field}.from`);
  const to = day(w.to, `${field}.to`);
  if (to < from) throw new SpecValidationError(`${field}.to must not precede ${field}.from`);
  return { from, to };
}

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new SpecValidationError(`${field} must be an integer`);
  }
  if (v < min || v > max) throw new SpecValidationError(`${field} must be ${min}-${max}`);
  return v;
}

function parseSpec(body: Record<string, unknown>): { spec: VariationSpec; budget: number } {
  const destinations = Array.isArray(body.destinations) ? body.destinations : [];
  if (destinations.length === 0) {
    throw new SpecValidationError('destinations must list at least one gateway');
  }
  if (destinations.length > 6) {
    throw new SpecValidationError('destinations supports at most 6 gateways');
  }

  const rawShapes = Array.isArray(body.shapes) && body.shapes.length > 0 ? body.shapes : ['round_trip'];
  const shapes = rawShapes.map((s, i) => {
    if (!SHAPES.includes(s as RouteShape)) {
      throw new SpecValidationError(`shapes[${i}] must be one of ${SHAPES.join(', ')}`);
    }
    return s as RouteShape;
  });

  const stay = (body.stayNights ?? {}) as { min?: unknown; max?: unknown };
  const minNights = int(stay.min, 'stayNights.min', 0, 365);
  const maxNights = int(stay.max, 'stayNights.max', 0, 365);
  if (maxNights < minNights) {
    throw new SpecValidationError('stayNights.max must not be less than stayNights.min');
  }

  const spec: VariationSpec = {
    origin: airport(body.origin, 'origin'),
    destinations: destinations.map((d, i) => airport(d, `destinations[${i}]`)),
    departWindow: window(body.departWindow, 'departWindow'),
    returnWindow: window(body.returnWindow, 'returnWindow'),
    stayNights: { min: minNights, max: maxNights },
    shapes,
    maxCombos: int(body.maxCombos ?? 24, 'maxCombos', 1, MAX_COMBOS_CEILING),
    dateStepDays: body.dateStepDays === undefined ? 1 : int(body.dateStepDays, 'dateStepDays', 1, 14),
  };

  const budget = int(body.requestBudget ?? 20, 'requestBudget', 1, MAX_REQUEST_BUDGET);
  return { spec, budget };
}

function parsePassengers(body: Record<string, unknown>): PartyPassengers {
  const adults = int(body.adults ?? 1, 'adults', 1, 9);
  const children = int(body.children ?? 0, 'children', 0, 8);
  const infantsInSeat = int(body.infantsInSeat ?? 0, 'infantsInSeat', 0, 8);
  const infantsOnLap = int(body.infantsOnLap ?? 0, 'infantsOnLap', 0, 8);

  if (adults + children + infantsInSeat + infantsOnLap > 9) {
    throw new SpecValidationError('total passengers must not exceed 9');
  }
  // Airline rule: a lap infant needs an adult lap to sit on.
  if (infantsOnLap > adults) {
    throw new SpecValidationError('infantsOnLap must not exceed adults');
  }
  return { adults, children, infantsInSeat, infantsOnLap };
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  let spec: VariationSpec;
  let requestBudget: number;
  let passengers: PartyPassengers;
  try {
    ({ spec, budget: requestBudget } = parseSpec(body));
    passengers = parsePassengers(body);
  } catch (err) {
    if (err instanceof SpecValidationError) return apiError(err.message, 400);
    throw err;
  }

  const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  const currency = (typeof body.currency === 'string' ? body.currency : null) ?? config?.defaultCurrency ?? null;
  const countryCode = typeof body.country === 'string' ? body.country : config?.defaultCountry ?? null;

  const pricer = createDataplanePricer({
    filters: {
      maxPrice: null,
      maxStops: null,
      maxDurationHours: null,
      preferredAirlines: [],
      timePreference: 'any',
      cabinClass: 'economy',
    },
    countryProfile: countryCode ? getCountryProfile(countryCode) : undefined,
    currency,
  });

  try {
    const result = await runVariationSearch(spec, passengers, pricer, { requestBudget });

    return apiSuccess({
      best: result.best,
      cells: result.cells,
      // Coverage, so the caller can tell a complete sweep from a partial one.
      coverage: {
        priced: result.cells.length,
        totalBeforeCap: result.totalBeforeCap,
        droppedByCap: result.droppedByCap,
        skippedForBudget: result.skippedForBudget,
        requestsUsed: result.requestsUsed,
        complete: result.droppedByCap === 0 && result.skippedForBudget === 0,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[variation] sweep failed: ${msg}`);
    return apiError('Variation sweep failed', 500);
  }
}
