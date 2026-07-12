/**
 * Production pricer for the variation search (ticket-tracker-izy).
 *
 * Bridges the pure `PriceQuery` seam in ./search.ts to the real two-tier Google
 * Flights data plane (SSR tier-1 + budgeted browser tier-2 + canary), so the sweep
 * can price real itineraries while the runner itself stays testable with fakes.
 *
 * Two things this deliberately gets right:
 *
 *  - deepSearch is ON. A variation sweep exists to find the CHEAPEST option, and
 *    Google's SSR tier only returns its top-5 "best" ranked flights — which hides
 *    the cheaper one-stop carriers (Fiji via NAN, Qantas via SYD) that a flexible
 *    trip actually wants. So we force the browser tier, which renders the full
 *    list. (ticket-tracker-k5m.8)
 *
 *  - The party total is what Google returns. Because the TfsQuery carries the
 *    passenger counts, Google prices the whole party in one figure — so the
 *    cheapest PriceData.price IS the family total, not a per-adult fare that would
 *    need multiplying. Multiplying it again would silently 5x the numbers.
 */
import type { TfsQuery } from '../dataplane/tfs-builder';
import type { FlightSearchParams } from '../scraper/navigate';
import type { QueryFilters } from '../scraper/extract-prices';
import type { CountryProfile } from '../scraper/country-profiles';
import { runTwoTierGoogleFlights, type PassengerCounts } from '../scraper/dataplane-integration';
import type { PriceQuery, QueryPrice } from './search';

/** Maps the tfs trip enum back onto the DB/scraper tripType string. */
const TRIP_TO_TYPE: Record<TfsQuery['trip'], string> = {
  'one-way': 'one_way',
  'round-trip': 'round_trip',
  'open-jaw': 'open_jaw',
  'multi-city': 'multi_city',
};

function toDate(iso: string): Date {
  return new Date(iso + 'T00:00:00Z');
}

/**
 * Reconstruct the scraper's FlightSearchParams from a TfsQuery so the existing
 * two-tier machinery (navigation, extraction, canary) can consume it.
 *
 * Multi-segment itineraries (open-jaw / multi-city) carry their ordered legs
 * through `segments` — the origin/destination/date pair alone cannot describe
 * them, and pairToTfsQuery would otherwise rebuild a mirrored round trip
 * (the k5m.5 bug).
 */
export function tfsQueryToSearchParams(
  query: TfsQuery,
  opts: { currency?: string | null; country?: string | null } = {},
): FlightSearchParams {
  const first = query.segments[0]!;
  const last = query.segments[query.segments.length - 1]!;
  const isMultiSegment = query.trip === 'open-jaw' || query.trip === 'multi-city';

  return {
    origin: first.fromAirport,
    destination: first.toAirport,
    dateFrom: toDate(first.date),
    dateTo: toDate(last.date),
    cabinClass: query.seat,
    tripType: TRIP_TO_TYPE[query.trip],
    currency: opts.currency ?? null,
    country: opts.country ?? null,
    adults: query.passengers.adults,
    children: query.passengers.children,
    infantsInSeat: query.passengers.infantsInSeat,
    infantsOnLap: query.passengers.infantsOnLap,
    ...(isMultiSegment
      ? {
          segments: query.segments.map((s) => ({
            from: s.fromAirport,
            to: s.toAirport,
            date: s.date,
          })),
        }
      : {}),
  };
}

export interface DataplanePricerDeps {
  filters: QueryFilters;
  countryProfile?: CountryProfile;
  proxyUrl?: string;
  currency?: string | null;
  /** Browser-tier requests a SINGLE query in the sweep may consume. */
  browserBudgetPerQuery?: number;
}

/**
 * Build the variation search's production `PriceQuery`: runs one TfsQuery through
 * the two-tier data plane and reduces it to (cheapest party total, availability).
 */
export function createDataplanePricer(deps: DataplanePricerDeps): PriceQuery {
  return async (query: TfsQuery): Promise<QueryPrice> => {
    const passengers: PassengerCounts = {
      adults: query.passengers.adults ?? 1,
      children: query.passengers.children ?? 0,
      infantsInSeat: query.passengers.infantsInSeat ?? 0,
      infantsOnLap: query.passengers.infantsOnLap ?? 0,
    };

    const result = await runTwoTierGoogleFlights({
      passengers,
      pairParams: tfsQueryToSearchParams(query, { currency: deps.currency }),
      filters: deps.filters,
      countryProfile: deps.countryProfile,
      proxyUrl: deps.proxyUrl,
      travelDateFallback: query.segments[0]!.date,
      browserBudget: deps.browserBudgetPerQuery ?? 3,
      // A sweep is hunting the CHEAPEST fare; the SSR top-5 hides the cheap
      // one-stop carriers, so always take the full-list browser tier.
      deepSearch: true,
    });

    // Google prices the whole party in one figure (the query carries the pax
    // counts), so the cheapest row IS the party total — do NOT multiply.
    const cheapest = result.prices.reduce<number | null>(
      (lo, p) => (lo === null || p.price < lo ? p.price : lo),
      null,
    );

    // availability is undefined when the run made no market determination (a
    // non-market failure such as an LLM error). Treat that as throttled rather
    // than claiming the route is sold out — we never checked.
    const availability = result.availability ?? 'throttled';

    return {
      total: availability === 'available' ? cheapest : null,
      currency: result.prices[0]?.currency ?? deps.currency ?? null,
      availability,
      requestsUsed: Math.max(1, result.browserRequestsUsed),
    };
  };
}
