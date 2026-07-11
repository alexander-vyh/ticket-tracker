// Integration seam between the two-tier Google Flights data plane
// (apps/web/src/lib/dataplane/*, built in ticket-tracker-lrq) and the existing
// Playwright + LLM scrape pipeline in run-scrape.ts / navigate.ts / extract-prices.ts.
//
// Kept as its own module (rather than folded into run-scrape.ts) so the mapping
// and adapter logic can be unit tested in isolation from the 780-line legacy
// chain-walk machinery. See ticket-tracker-uwj and .research/flight-tracker-2026-07-10/08-orchestrator.md.

import type { TfsQuery, TfsSeat, TfsTrip } from '../dataplane/tfs-builder';
import { buildTfsUrl } from '../dataplane/tfs-builder';
import { fetchSsr } from '../dataplane/ssr-fetch';
import { orchestrateScrape } from '../dataplane/orchestrator';
import type { Availability, BrowserFetchResult, Tier } from '../dataplane/orchestrator';
import type { DataplaneFlight } from '../dataplane/types';
import { navigateGoogleFlights, navigateGoogleFlightsUrl } from './navigate';
import type { FlightSearchParams } from './navigate';
import { extractPrices } from './extract-prices';
import type { ExtractionFailureReason, PriceData, QueryFilters } from './extract-prices';
import type { CountryProfile } from './country-profiles';

export interface PassengerCounts {
  adults: number;
  children: number;
  infantsInSeat: number;
  infantsOnLap: number;
}

const CABIN_MAP: Record<string, TfsSeat> = {
  economy: 'economy',
  premium_economy: 'premium-economy',
  business: 'business',
  first: 'first',
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Maps a scrape date pair + passenger counts into the TfsQuery the dataplane builder expects. */
export function pairToTfsQuery(
  params: Pick<FlightSearchParams, 'origin' | 'destination' | 'dateFrom' | 'dateTo' | 'tripType' | 'cabinClass'>,
  passengers: PassengerCounts,
): TfsQuery {
  const trip: TfsTrip = params.tripType === 'one_way' ? 'one-way' : 'round-trip';
  const seat: TfsSeat = CABIN_MAP[params.cabinClass ?? 'economy'] ?? 'economy';
  const outbound = { date: isoDay(params.dateFrom), fromAirport: params.origin, toAirport: params.destination };
  const segments =
    trip === 'one-way'
      ? [outbound]
      : [outbound, { date: isoDay(params.dateTo), fromAirport: params.destination, toAirport: params.origin }];
  return {
    trip,
    seat,
    segments,
    passengers: {
      adults: passengers.adults,
      children: passengers.children,
      infantsInSeat: passengers.infantsInSeat,
      infantsOnLap: passengers.infantsOnLap,
    },
  };
}

/**
 * Strips children/infants down to an adults-only variant of the same route+dates.
 * Used to build the canary query: SSR reliably prices adults-only itineraries even
 * when the real (mixed-age) query gets deferred out of SSR — see design.md's
 * riskiest-assumption finding and the uwj review amendment (5 adults SSR-priced
 * $6,448 while the real browser tier was throttled on "No results").
 */
export function adultsOnlyVariant(query: TfsQuery): TfsQuery {
  return {
    ...query,
    passengers: {
      adults: Math.max(query.passengers.adults ?? 1, 1),
      children: 0,
      infantsInSeat: 0,
      infantsOnLap: 0,
    },
  };
}

/**
 * Maps an extracted PriceData row into the dataplane's DataplaneFlight shape.
 * Lossy by design: DataplaneFlight only needs to support the orchestrator's own
 * ok/empty decision (flights.length > 0). The real PriceData row — with
 * bookingUrl, stops, flightNumber, seatsLeft etc. — is what actually gets
 * persisted as a PriceSnapshot; it is carried separately by the fetchBrowser
 * adapter's getPrices(), never reconstructed from the DataplaneFlight mapping.
 */
export function priceDataToDataplaneFlight(p: PriceData, origin: string, destination: string): DataplaneFlight {
  return {
    price: p.price,
    airlines: [p.airline],
    legs: [
      {
        fromAirport: origin,
        fromAirportName: null,
        toAirport: destination,
        toAirportName: null,
        departureDate: null,
        departureTime: null,
        arrivalDate: null,
        arrivalTime: null,
        duration: null,
        planeType: null,
      },
    ],
  };
}

function isoFromDataplaneDate(d: number[] | null): string | null {
  if (!d || d.length < 3) return null;
  const [y, m, day] = d;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatDataplaneTime(t: (number | null)[] | null): string | null {
  if (!t || t[0] == null) return null;
  return `${String(t[0]).padStart(2, '0')}:${String(t[1] ?? 0).padStart(2, '0')}`;
}

/**
 * Maps an SSR-tier (Tier 1) DataplaneFlight back into a persistable PriceData
 * row. This is the ONLY place tier-1 flights get converted to a snapshot —
 * unlike the browser-tier adapter, SSR has no separate "original PriceData"
 * to preserve, since DataplaneFlight IS its native shape.
 *
 * For round-trip queries, Google's SSR payload carries ONLY the outbound leg
 * — the return leg's flight number/times/plane are never present at all
 * (Google's SSR renders "pick your outbound" cards with a precomputed RT
 * total; see Serena memory dataplane/ssr-roundtrip-legs-semantics, direct
 * payload evidence 2026-07-10). `legs[0]` is therefore always treated as the
 * outbound schedule, and `price` as whatever total SSR reports (single-leg
 * total for one-way, RT total for round-trip) — this mapping never
 * fabricates return-leg detail. DataplaneLeg carries no flight-number field
 * at all, so flightNumber is always null here (matches what SSR actually
 * gives us, not a gap in this mapping).
 */
export function dataplaneFlightToPriceData(flight: DataplaneFlight, fallbackTravelDate: string, currency: string): PriceData {
  const outbound = flight.legs[0];
  const durationMin = outbound?.duration ?? null;
  return {
    travelDate: isoFromDataplaneDate(outbound?.departureDate ?? null) ?? fallbackTravelDate,
    price: flight.price,
    currency,
    airline: flight.airlines[0] ?? 'Unknown',
    bookingUrl: null,
    stops: Math.max(0, flight.legs.length - 1),
    duration: durationMin != null ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m` : null,
    departureTime: formatDataplaneTime(outbound?.departureTime ?? null),
    arrivalTime: formatDataplaneTime(outbound?.arrivalTime ?? null),
    seatsLeft: null,
    flightNumber: null,
  };
}

export interface FetchBrowserAdapterDeps {
  pairParams: FlightSearchParams;
  filters: QueryFilters;
  countryProfile: CountryProfile | undefined;
  proxyUrl: string | undefined;
  travelDateFallback: string;
}

export interface FetchBrowserAdapter {
  fetchBrowser: (query: TfsQuery) => Promise<BrowserFetchResult>;
  getPrices: () => PriceData[];
  getUsage: () => { inputTokens: number; outputTokens: number };
  getFailureReason: () => ExtractionFailureReason | undefined;
  getLastHtml: () => string | undefined;
}

/**
 * Builds the orchestrator's `fetchBrowser` dependency: drives the tfs URL through
 * the browser first (navigateGoogleFlightsUrl), and — only when the tfs attempt
 * yields no results (including if it throws; the tfs path is a new, speculative
 * navigation and must never break the proven q= path) — falls back to the
 * existing NL-phrase navigateGoogleFlights. Either way, extraction runs exactly
 * once per call.
 *
 * The real PriceData rows from that single extraction are captured via
 * getPrices() for the caller to persist; the returned BrowserFetchResult only
 * carries a lossy DataplaneFlight mapping for the orchestrator's own bookkeeping.
 */
export function createFetchBrowserAdapter(deps: FetchBrowserAdapterDeps): FetchBrowserAdapter {
  let prices: PriceData[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let failureReason: ExtractionFailureReason | undefined;
  let lastHtml: string | undefined;

  async function fetchBrowser(query: TfsQuery): Promise<BrowserFetchResult> {
    const tfsUrl = buildTfsUrl(query, {
      curr: deps.pairParams.currency ?? undefined,
      gl: deps.countryProfile?.code,
      hl: deps.countryProfile?.locale?.split('-')[0],
    });

    let nav = null as Awaited<ReturnType<typeof navigateGoogleFlights>> | null;
    try {
      const tfsNav = await navigateGoogleFlightsUrl(tfsUrl, deps.pairParams, deps.countryProfile, deps.proxyUrl);
      if (tfsNav.resultsFound) nav = tfsNav;
    } catch {
      // tfs navigation is speculative — any failure (including a throw) falls
      // through to the proven q= path below rather than propagating.
    }
    if (!nav) {
      nav = await navigateGoogleFlights(deps.pairParams, deps.countryProfile, deps.proxyUrl);
    }

    lastHtml = nav.html;
    const extraction = await extractPrices(
      nav.html,
      nav.url,
      deps.travelDateFallback,
      deps.filters,
      undefined,
      nav.resultsFound,
      nav.source,
      deps.pairParams.currency ?? null,
    );
    prices = extraction.prices;
    usage = extraction.usage;
    failureReason = extraction.failureReason;

    if (prices.length === 0) {
      return { status: 'ok', flights: [] };
    }
    return {
      status: 'ok',
      flights: prices.map((p) => priceDataToDataplaneFlight(p, deps.pairParams.origin, deps.pairParams.destination)),
    };
  }

  return {
    fetchBrowser,
    getPrices: () => prices,
    getUsage: () => usage,
    getFailureReason: () => failureReason,
    getLastHtml: () => lastHtml,
  };
}

/**
 * Builds the orchestrator's `canaryHasInventory` dependency: a plain SSR fetch
 * (Tier 1, throttle-resilient) on an adults-only variant of the query. Per the
 * uwj review amendment, this is the only trustworthy way to distinguish a
 * genuinely sold-out route from a soft-blocked/throttled browser tier.
 */
export function createCanaryHasInventory(
  pairParams: Pick<FlightSearchParams, 'currency'>,
): (query: TfsQuery) => Promise<boolean> {
  return async (query: TfsQuery): Promise<boolean> => {
    const canaryQuery = adultsOnlyVariant(query);
    const result = await fetchSsr(canaryQuery, { curr: pairParams.currency ?? undefined });
    return result.status === 'ok' && result.flights.length > 0;
  };
}

// Failure reasons that carry no market-availability signal: the canary result
// is orthogonal to whether the LLM/parser was healthy (llm_error/json_parse_error/
// no_json_in_response) or whether the user's own filters excluded real flights
// (all_filtered_out). Reporting no_options/throttled for these would misdiagnose
// "our extraction pipeline failed" as "we checked the market and here's the
// answer" — a stronger, false claim the pipeline never earned.
const NON_MARKET_FAILURE_REASONS: ReadonlySet<ExtractionFailureReason> = new Set([
  'all_filtered_out',
  'llm_error',
  'json_parse_error',
  'no_json_in_response',
]);

export interface TwoTierResult {
  prices: PriceData[];
  usage: { inputTokens: number; outputTokens: number };
  failureReason?: ExtractionFailureReason;
  /**
   * undefined when no market-availability determination was made this call —
   * either because the failure was a non-market one (see
   * NON_MARKET_FAILURE_REASONS) or because the caller's chain-walk fallback
   * subsequently found real prices via a different source (that reset is the
   * caller's responsibility, not this function's).
   */
  availability: Availability | undefined;
  tier: Tier;
  /** null = canary never consulted (SSR-tier or first-try browser success). */
  canaryOk: boolean | null;
  lastHtml?: string;
  /** Browser-tier requests consumed (browser fetch + canary, if invoked) — for the caller's per-run budget accounting. */
  browserRequestsUsed: number;
}

export interface TwoTierDeps {
  passengers: PassengerCounts;
  pairParams: FlightSearchParams;
  filters: QueryFilters;
  countryProfile: CountryProfile | undefined;
  proxyUrl: string | undefined;
  travelDateFallback: string;
  browserBudget: number;
}

/**
 * Runs the full two-tier decision (orchestrateScrape) for one round-trip/one-way
 * date pair against Google Flights, wiring in the real SSR fetch, the tfs-first
 * browser adapter, and the SSR-based canary — and returns a result shaped for
 * direct FetchRun/PriceSnapshot persistence by the caller.
 */
export async function runTwoTierGoogleFlights(deps: TwoTierDeps): Promise<TwoTierResult> {
  const tfsQuery = pairToTfsQuery(deps.pairParams, deps.passengers);
  const browserAdapter = createFetchBrowserAdapter({
    pairParams: deps.pairParams,
    filters: deps.filters,
    countryProfile: deps.countryProfile,
    proxyUrl: deps.proxyUrl,
    travelDateFallback: deps.travelDateFallback,
  });
  const canary = createCanaryHasInventory(deps.pairParams);

  let canaryInvoked = false;
  let canaryResult: boolean | null = null;
  const canaryWrapped = async (query: TfsQuery): Promise<boolean> => {
    canaryInvoked = true;
    canaryResult = await canary(query);
    return canaryResult;
  };

  const result = await orchestrateScrape(
    tfsQuery,
    {
      fetchSsr: (q) => fetchSsr(q, { curr: deps.pairParams.currency ?? undefined }),
      fetchBrowser: browserAdapter.fetchBrowser,
      canaryHasInventory: canaryWrapped,
    },
    { browserBudget: deps.browserBudget },
  );

  const failureReason = browserAdapter.getFailureReason();
  const isNonMarketFailure = failureReason !== undefined && NON_MARKET_FAILURE_REASONS.has(failureReason);

  // The SSR (tier-1) success path never calls fetchBrowser at all — the real
  // flight data lives in orchestrateScrape's OWN return value (result.flights),
  // not in the browser adapter's capture. Mapping is required here (SSR has
  // no separate "original PriceData" the way the browser tier does).
  const prices =
    result.tier === 'ssr'
      ? result.flights.map((f) => dataplaneFlightToPriceData(f, deps.travelDateFallback, deps.pairParams.currency ?? 'USD'))
      : browserAdapter.getPrices();

  return {
    prices,
    usage: browserAdapter.getUsage(),
    failureReason,
    availability: isNonMarketFailure ? undefined : result.availability,
    tier: result.tier,
    canaryOk: canaryInvoked ? canaryResult : null,
    lastHtml: browserAdapter.getLastHtml(),
    browserRequestsUsed: result.browserRequestsUsed,
  };
}
