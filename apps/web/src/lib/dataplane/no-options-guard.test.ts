import { describe, expect, it } from 'vitest';
import {
  cellKeyOf,
  isStrictlySmallerParty,
  judgeEmptyResult,
  needsMonotonicityProbe,
  partySize,
  samePartyTuple,
  type PartyProbe,
} from './no-options-guard';
import type { TfsQuery } from './tfs-builder';

// oracle: measured live on 2026-07-11, LAX->AKL Dec 10 -> Dec 28, interleaved
// within minutes on one tab and one IP —
//
//     1 adult  -> 8 results, from $745      4 pax -> "No options"  <- FABRICATED
//     2 adults -> 8 results, $1,489         5 pax -> "No options"  <- FABRICATED
//     3 adults -> 8 results, $2,233
//
// It is a party-size gate, not a rate limit: no decay over 90 minutes (incl. 20
// of silence), not cookie-keyed. Proof the >=4 zeros are FABRICATED rather than
// true: a 4-passenger query for Dec 1 -> Dec 22 returned "No options" on a cell
// watched rendering 12 itineraries SEATING FIVE an hour earlier — and any
// itinerary that seats 5 necessarily seats 4.
//
// These are behavioral requirements about what the product may CLAIM, not
// implementation echoes: `no_options` asserts "the market has no flights", and
// an empty page alone never earns it.

const FAMILY: TfsQuery = {
  trip: 'round-trip',
  seat: 'economy',
  segments: [
    { date: '2026-12-10', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2026-12-28', fromAirport: 'AKL', toAirport: 'LAX' },
  ],
  passengers: { adults: 3, children: 2 },
};
const SOLO: TfsQuery = { ...FAMILY, passengers: { adults: 1 } };

/** A reference cell that is NOT the query's own cell. */
const REFERENCE_CELL = cellKeyOf({
  ...FAMILY,
  segments: [
    { date: '2026-12-01', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2026-12-22', fromAirport: 'AKL', toAirport: 'LAX' },
  ],
});

function canaryFor(query: TfsQuery, foundFlights: boolean): PartyProbe {
  return { passengers: { ...query.passengers }, cellKey: REFERENCE_CELL, foundFlights };
}
function monotonicityFor(query: TfsQuery, foundFlights: boolean): PartyProbe {
  return { passengers: { adults: 1 }, cellKey: cellKeyOf(query), foundFlights };
}

describe('party arithmetic', () => {
  it('counts every traveller Google is asked to seat, lap infants included', () => {
    expect(partySize({ adults: 3, children: 2 })).toBe(5);
    expect(partySize({ adults: 2, children: 1, infantsInSeat: 1, infantsOnLap: 1 })).toBe(5);
    expect(partySize({})).toBe(1); // adults defaults to 1
  });

  it('treats 2a+0c and 1a+1c as DIFFERENT parties even though both are 2 passengers', () => {
    // Different fare classes and eligibility rules — neither may stand in for the
    // other as a canary, so head-count equality is not enough.
    expect(partySize({ adults: 2 })).toBe(partySize({ adults: 1, children: 1 }));
    expect(samePartyTuple({ adults: 2 }, { adults: 1, children: 1 })).toBe(false);
  });

  it('is a strict sub-party only when componentwise <= AND strictly smaller', () => {
    expect(isStrictlySmallerParty({ adults: 1 }, { adults: 3, children: 2 })).toBe(true);
    expect(isStrictlySmallerParty({ adults: 2, children: 1 }, { adults: 3, children: 2 })).toBe(true);
    // Same size is not smaller.
    expect(isStrictlySmallerParty({ adults: 3, children: 2 }, { adults: 3, children: 2 })).toBe(false);
    // 5 adults is NOT a sub-party of 3 adults + 2 children: swapping a child for
    // an adult changes fare eligibility, so the seats-subset argument does not
    // hold. A total-only test would wrongly admit this.
    expect(isStrictlySmallerParty({ adults: 5 }, { adults: 3, children: 2 })).toBe(false);
  });

  it('fires the monotonicity probe only when there IS a smaller party to probe', () => {
    expect(needsMonotonicityProbe(FAMILY)).toBe(true);
    expect(needsMonotonicityProbe(SOLO)).toBe(false);
  });
});

describe('judgeEmptyResult: an empty page must EARN the claim "no flights"', () => {
  it('(a) empty target + PARTY-MATCHED canary with inventory + no smaller party beating it => confirmed no_options', () => {
    const verdict = judgeEmptyResult({
      query: FAMILY,
      canary: canaryFor(FAMILY, true), // 5-pax reference cell renders => channel healthy at 5 pax
      monotonicity: monotonicityFor(FAMILY, false), // 1 adult finds nothing here either
    });
    expect(verdict).toEqual({ kind: 'confirmed', partySize: 5, canaryCell: REFERENCE_CELL });
  });

  it('(b) empty target + EMPTY canary => unverified, never no_options (this is the >=4 gate being caught)', () => {
    // With the gate up, the reference cell — watched rendering 12 itineraries at
    // 5 pax — comes back empty at 5 pax. That is the channel lying, not the market
    // emptying, and it must veto every sold-out claim at this party size.
    const verdict = judgeEmptyResult({
      query: FAMILY,
      canary: canaryFor(FAMILY, false),
      monotonicity: null,
    });
    expect(verdict).toEqual({ kind: 'unverified', reason: 'canary_empty' });
  });

  it('(c) MONOTONICITY: 5-pax empty but 1 adult finds flights on the SAME cell => never no_options', () => {
    // Availability cannot grow as the party grows. A smaller party out-finding the
    // full party on the same cell means the full-party zero has not earned the
    // word "sold out" — even though the canary is green.
    const verdict = judgeEmptyResult({
      query: FAMILY,
      canary: canaryFor(FAMILY, true),
      monotonicity: monotonicityFor(FAMILY, true),
    });
    expect(verdict).toEqual({ kind: 'unverified', reason: 'monotonicity_violation' });
  });

  it('(d) THE LAUNDERING BUG: a 1-adult canary is NOT valid cover for a 5-passenger query', () => {
    // This is the exact shape of the old adultsOnlyVariant() canary, and the
    // reason a naive canary is WORSE than none: a 1-adult probe passes Google's
    // party gate all night, so it would certify the fabricated 5-pax zero as a
    // genuine sold-out — reporting "sold out" with a green check beside it.
    // The guard must reject it on party mismatch ALONE, even though the probe
    // found flights and even though a clean monotonicity probe accompanies it.
    const oneAdultCanary: PartyProbe = {
      passengers: { adults: 1 },
      cellKey: REFERENCE_CELL,
      foundFlights: true,
    };
    const verdict = judgeEmptyResult({
      query: FAMILY,
      canary: oneAdultCanary,
      monotonicity: monotonicityFor(FAMILY, false),
    });
    expect(verdict).toEqual({ kind: 'unverified', reason: 'canary_party_mismatch' });
  });

  it('rejects a canary that merely matches HEAD-COUNT but not the passenger tuple', () => {
    // 5 adults is not 3 adults + 2 children. Google prices and gates them
    // differently, so a 5-adult probe cannot vouch for the family.
    const fiveAdults: PartyProbe = { passengers: { adults: 5 }, cellKey: REFERENCE_CELL, foundFlights: true };
    const verdict = judgeEmptyResult({
      query: FAMILY,
      canary: fiveAdults,
      monotonicity: monotonicityFor(FAMILY, false),
    });
    expect(verdict).toEqual({ kind: 'unverified', reason: 'canary_party_mismatch' });
  });

  it('refuses to confirm with no canary at all — an empty page alone is never a market verdict', () => {
    expect(judgeEmptyResult({ query: FAMILY, canary: null, monotonicity: null })).toEqual({
      kind: 'unverified',
      reason: 'canary_absent',
    });
  });

  it('refuses a canary that is the query under test — re-observing the target proves nothing', () => {
    const selfCanary: PartyProbe = {
      passengers: { ...FAMILY.passengers },
      cellKey: cellKeyOf(FAMILY),
      foundFlights: true,
    };
    expect(judgeEmptyResult({ query: FAMILY, canary: selfCanary, monotonicity: null })).toEqual({
      kind: 'unverified',
      reason: 'canary_is_target',
    });
  });

  it('refuses to confirm a party >= 2 when the monotonicity probe could not be run (budget starvation fails CLOSED)', () => {
    expect(judgeEmptyResult({ query: FAMILY, canary: canaryFor(FAMILY, true), monotonicity: null })).toEqual({
      kind: 'unverified',
      reason: 'monotonicity_probe_missing',
    });
  });

  it('rejects a monotonicity probe run on a DIFFERENT cell — it says nothing about the target', () => {
    const wrongCell: PartyProbe = { passengers: { adults: 1 }, cellKey: REFERENCE_CELL, foundFlights: false };
    expect(judgeEmptyResult({ query: FAMILY, canary: canaryFor(FAMILY, true), monotonicity: wrongCell })).toEqual({
      kind: 'unverified',
      reason: 'monotonicity_probe_invalid',
    });
  });

  it('rejects a monotonicity probe that did not actually shrink the party', () => {
    const notSmaller: PartyProbe = {
      passengers: { ...FAMILY.passengers },
      cellKey: cellKeyOf(FAMILY),
      foundFlights: false,
    };
    expect(judgeEmptyResult({ query: FAMILY, canary: canaryFor(FAMILY, true), monotonicity: notSmaller })).toEqual({
      kind: 'unverified',
      reason: 'monotonicity_probe_invalid',
    });
  });

  it('a solo query needs no monotonicity probe: a party-matched canary alone confirms it', () => {
    // There is no smaller party than 1 adult, so the canary is the whole test.
    const verdict = judgeEmptyResult({ query: SOLO, canary: canaryFor(SOLO, true), monotonicity: null });
    expect(verdict).toEqual({ kind: 'confirmed', partySize: 1, canaryCell: REFERENCE_CELL });
  });

  it('regression, the whole point: NO combination of inputs reaches no_options without a party-matched, non-empty canary', () => {
    // Exhaustive over the guard's inputs. If any future edit lets a `confirmed`
    // escape while the canary is absent, mismatched, or empty, this fails.
    const canaries: (PartyProbe | null)[] = [
      null,
      canaryFor(FAMILY, false), // empty
      { passengers: { adults: 1 }, cellKey: REFERENCE_CELL, foundFlights: true }, // mismatched party
      { passengers: { ...FAMILY.passengers }, cellKey: cellKeyOf(FAMILY), foundFlights: true }, // self-referential
    ];
    const monos: (PartyProbe | null)[] = [null, monotonicityFor(FAMILY, false), monotonicityFor(FAMILY, true)];

    for (const canary of canaries) {
      for (const monotonicity of monos) {
        expect(judgeEmptyResult({ query: FAMILY, canary, monotonicity }).kind).toBe('unverified');
      }
    }
  });
});
