/**
 * The two browser-tier probes that guard `no_options`. Pure decision logic lives
 * in ../dataplane/no-options-guard.ts; this module only performs the requests and
 * reports, honestly, what it actually ran.
 *
 * TWO THINGS THE PREVIOUS CANARY GOT WRONG, both of which made it a rubber stamp:
 *
 *  1. IT STRIPPED THE PARTY. `adultsOnlyVariant()` turned a 3-adult + 2-child
 *     query into a 3-ADULT canary. Google gates parties of >= 4 with a fabricated
 *     empty page, so the 3-adult probe sailed through and certified the fabricated
 *     5-passenger zero as a genuine sold-out. A guardrail that is present, green,
 *     and laundering false negatives is strictly WORSE than no guardrail: it
 *     manufactures confidence in a lie. Every probe here is party-matched.
 *
 *  2. IT PROBED THE WRONG TIER. It ran `fetchSsr`, but the result it vouched for
 *     came from the BROWSER. A browser soft-block — the exact failure the canary
 *     exists to catch — leaves SSR perfectly healthy, so the canary returned true
 *     under the one condition it was built to detect. Both probes here go through
 *     the same browser path as the query they guard, so party size (or the cell)
 *     is the ONLY variable that changes. An unconfounded comparison is what makes
 *     the inference worth anything.
 */
import type { TfsQuery } from '../dataplane/tfs-builder';
import { buildTfsUrl } from '../dataplane/tfs-builder';
import { cellKeyOf, type PartyProbe } from '../dataplane/no-options-guard';
import { navigateGoogleFlightsUrl } from './navigate';
import type { FlightSearchParams } from './navigate';
import type { CountryProfile } from './country-profiles';

export interface ReferenceCell {
  origin: string;
  destination: string;
  /** ISO date */
  departDate: string;
  /** ISO date */
  returnDate: string;
}

/**
 * A route+date pair with inventory deep enough that an empty page for it means
 * the CHANNEL is broken, not that the market is.
 *
 * Chosen because it is the most heavily corroborated cell we have: watched live
 * on 2026-07-11 rendering 12 itineraries SEATING FIVE at a $3,725 floor, and
 * rendering 8 results at 1, 2 and 3 passengers within minutes of each other.
 *
 * WHAT AN EMPTY CANARY HERE MEANS: not "LAX->AKL sold out" but "Google is not
 * answering queries at this party size right now". That is exactly the
 * proposition we need, and it is why the canary is valid cover for a query on
 * ANY route: the >= 4 party gate is a property of the channel, not of a route.
 *
 * STALENESS IS A REAL RISK and it fails in the safe direction: if this cell ever
 * genuinely sells out, the canary goes red, every empty becomes `unverified`, and
 * the tracker stops claiming sold-outs rather than fabricating them. Loud and
 * safe, not silent and wrong.
 */
export const KNOWN_GOOD_REFERENCE_CELL: ReferenceCell = {
  origin: 'LAX',
  destination: 'AKL',
  departDate: '2026-12-01',
  returnDate: '2026-12-22',
};

/**
 * The party the monotonicity probe drops to. One adult is the smallest possible
 * party, is a strict sub-party of ANY party of >= 2, and is the size Google is
 * least likely to gate — so if this cannot find flights either, the cell really
 * is empty.
 */
export const MONOTONICITY_PROBE_PARTY = { adults: 1, children: 0, infantsInSeat: 0, infantsOnLap: 0 } as const;

export interface ProbeDeps {
  countryProfile: CountryProfile | undefined;
  proxyUrl: string | undefined;
  currency: string | null | undefined;
  /** The target query's route params — used by the monotonicity probe, which
   *  re-runs the target's OWN cell. */
  pairParams: FlightSearchParams;
  referenceCell?: ReferenceCell;
}

function isoToDate(iso: string): Date {
  // Midday UTC: any timezone offset the browser layer applies still lands on the
  // intended calendar day.
  return new Date(`${iso}T12:00:00Z`);
}

/** Run a TfsQuery through the browser tier; did it render priced itineraries? */
async function browserFindsFlights(
  query: TfsQuery,
  params: FlightSearchParams,
  deps: ProbeDeps,
): Promise<boolean> {
  const url = buildTfsUrl(query, {
    curr: deps.currency ?? undefined,
    gl: deps.countryProfile?.code,
    hl: deps.countryProfile?.locale?.split('-')[0],
  });
  try {
    const nav = await navigateGoogleFlightsUrl(url, params, deps.countryProfile, deps.proxyUrl);
    return nav.resultsFound;
  } catch {
    // A probe that THREW did not see inventory. Fail closed: `false` can only
    // ever push the verdict toward `unverified`, never toward a sold-out claim.
    return false;
  }
}

/**
 * CANARY: the known-good reference cell, run at the SAME PARTY SIZE as the query
 * it guards.
 *
 * It reports the party and cell it actually ran, and the guard re-checks them —
 * so a probe that quietly dropped the children (as the old one did) is caught by
 * `judgeEmptyResult` as `canary_party_mismatch` rather than silently certifying a
 * fabricated zero.
 */
export function createPartyMatchedCanary(deps: ProbeDeps): (query: TfsQuery) => Promise<PartyProbe> {
  const cell = deps.referenceCell ?? KNOWN_GOOD_REFERENCE_CELL;

  return async (query: TfsQuery): Promise<PartyProbe> => {
    const canaryQuery: TfsQuery = {
      trip: 'round-trip',
      seat: query.seat,
      segments: [
        { date: cell.departDate, fromAirport: cell.origin, toAirport: cell.destination },
        { date: cell.returnDate, fromAirport: cell.destination, toAirport: cell.origin },
      ],
      // THE WHOLE POINT. Not adultsOnlyVariant(). Not one adult. The same party
      // Google just refused to answer for.
      passengers: { ...query.passengers },
    };

    const params: FlightSearchParams = {
      origin: cell.origin,
      destination: cell.destination,
      dateFrom: isoToDate(cell.departDate),
      dateTo: isoToDate(cell.returnDate),
      tripType: 'round_trip',
      currency: deps.currency ?? null,
    };

    const foundFlights = await browserFindsFlights(canaryQuery, params, deps);
    console.log(
      `[canary] reference ${cell.origin}->${cell.destination} ${cell.departDate}/${cell.returnDate} ` +
        `at the TARGET's party (${JSON.stringify(canaryQuery.passengers)}): ` +
        `${foundFlights ? 'inventory visible — channel healthy at this party size' : 'EMPTY — channel gated/blocked at this party size, no sold-out claim may be made'}`,
    );
    return {
      passengers: canaryQuery.passengers,
      cellKey: cellKeyOf(canaryQuery),
      foundFlights,
    };
  };
}

/**
 * MONOTONICITY PROBE: the query's OWN cell, re-run at one adult.
 *
 * Seat availability cannot grow as a party grows — an itinerary that seats 5
 * necessarily seats 1. So if the full party found nothing here but a single adult
 * finds priced itineraries, the full-party zero has not earned the word
 * "sold out". (`judgeEmptyResult` documents precisely how strong that inference
 * is and where it stops being a proof; it is applied as a hard veto because the
 * two ways of being wrong are not remotely symmetric.)
 */
export function createMonotonicityProbe(deps: ProbeDeps): (query: TfsQuery) => Promise<PartyProbe> {
  return async (query: TfsQuery): Promise<PartyProbe> => {
    const probeQuery: TfsQuery = {
      ...query, // same route, same dates, same trip shape — party is the ONLY change
      passengers: { ...MONOTONICITY_PROBE_PARTY },
    };

    const foundFlights = await browserFindsFlights(probeQuery, deps.pairParams, deps);
    console.log(
      `[canary] monotonicity probe on the target cell at 1 adult: ` +
        `${foundFlights ? 'FOUND FLIGHTS — a smaller party beat the full party, so the full-party zero is NOT a sold-out' : 'also empty — consistent with a genuinely empty cell'}`,
    );
    return {
      passengers: probeQuery.passengers,
      cellKey: cellKeyOf(probeQuery),
      foundFlights,
    };
  };
}
