/**
 * The `no_options` guard — the ONLY place an empty results page may be promoted
 * into the market claim "there are no flights for this party on this date".
 *
 * WHY THIS MODULE EXISTS
 *
 * "Google rendered an empty-results page" and "there are no flights" are
 * DIFFERENT PROPOSITIONS. The first is an observation about a web page; the
 * second is a claim about the world. Only a positive control bridges them, and
 * the bridge is load-bearing because Google Flights *fabricates* the first one.
 *
 * Measured 2026-07-11, LAX->AKL Dec 10 -> Dec 28, interleaved within minutes on
 * one tab and one IP:
 *
 *     1 adult -> 8 results, from $745        4 pax -> "No options"   <- FAKE
 *     2 adults -> 8 results, $1,489          5 pax -> "No options"   <- FAKE
 *     3 adults -> 8 results, $2,233
 *
 * It is a PARTY-SIZE GATE, not a rate limit: it did not decay over 90 minutes
 * (including 20 of total silence) and it is not cookie-keyed (a fresh profile is
 * blocked identically). Parties of >= 4 get a fabricated empty page on EVERY
 * date. Proof that it is fabricated rather than true: a 4-passenger query for
 * Dec 1 -> Dec 22 returned "No options" on a cell that had been watched
 * rendering 12 itineraries SEATING FIVE an hour earlier. Any itinerary that
 * seats 5 necessarily seats 4, so that zero cannot be true.
 *
 * THE TRAP THIS MODULE IS SHAPED TO AVOID
 *
 * The obvious canary — "ask for 1 adult on a route we know is flying" — passes
 * Google's gate all night long. Wired up naively it would certify every
 * fabricated 5-passenger zero as a genuine sold-out, and the product would
 * report "sold out" WITH A GREEN CHECK BESIDE IT. That is strictly worse than
 * having no canary at all, because it manufactures confidence in a lie. Hence:
 *
 *   - A probe SELF-REPORTS the passenger tuple and cell it actually ran, so the
 *     guard VERIFIES the match instead of trusting the caller. A bare boolean
 *     cannot be audited; a `PartyProbe` can.
 *   - The canary must be PARTY-MATCHED (identical passenger tuple). A probe at
 *     any other party size is rejected outright — it attests to a channel we did
 *     not use.
 *   - `no_options` is unreachable except through a `confirmed` verdict, which
 *     only `judgeEmptyResult` can mint.
 *
 * WHAT THE TWO PROBES EACH PROVE
 *
 * They are independent and complementary:
 *
 *   CANARY (known-good reference cell, SAME party size) attests to CHANNEL
 *   HEALTH AT THIS PARTY SIZE — "Google is answering >=N-passenger queries
 *   truthfully right now". It needs a trusted reference cell, and it is what
 *   catches the global >=4 gate.
 *
 *   MONOTONICITY (the TARGET cell, a strictly smaller party) needs no reference
 *   cell, so it works on routes we have no baseline for. See
 *   `judgeEmptyResult` for exactly how strong this inference is — it is a
 *   fail-safe, and the honest bound on it is documented there rather than
 *   overstated here.
 */
import type { TfsPassengers, TfsQuery } from './tfs-builder';

/**
 * Total travellers Google is asked to seat.
 *
 * Lap infants are INCLUDED. They occupy no seat, so they are arguably irrelevant
 * to a seat-scarcity argument — but Google's gate keys on the passenger
 * selector, not on seat count, and we have not measured which side lap infants
 * fall on. Counting them makes the party look larger, which can only ever demand
 * a *stricter* canary. That is the fail-safe direction, so we take it knowingly.
 */
export function partySize(p: TfsPassengers): number {
  return (p.adults ?? 1) + (p.children ?? 0) + (p.infantsInSeat ?? 0) + (p.infantsOnLap ?? 0);
}

function tuple(p: TfsPassengers): [number, number, number, number] {
  return [p.adults ?? 1, p.children ?? 0, p.infantsInSeat ?? 0, p.infantsOnLap ?? 0];
}

/**
 * Identical passenger tuples — not merely an equal head-count. 2a+0c and 1a+1c
 * are both "2 passengers" but are different queries to Google (different fare
 * classes, different eligibility), so neither may stand in for the other.
 */
export function samePartyTuple(a: TfsPassengers, b: TfsPassengers): boolean {
  const [x, y] = [tuple(a), tuple(b)];
  return x.every((v, i) => v === y[i]);
}

/**
 * Is `probe` a strict sub-party of `target`? Componentwise <= with a strictly
 * smaller total.
 *
 * Componentwise (rather than just a smaller total) because the monotonicity
 * argument is about REMOVING travellers from a party: an itinerary that seats
 * 3 adults + 2 children necessarily seats 1 adult, and necessarily seats
 * 2 adults + 1 child. It does NOT follow that it seats 5 adults — swapping a
 * child for an adult changes fare eligibility, not just headcount. A total-only
 * test would wrongly admit 5a as a sub-party of 3a+2c.
 */
export function isStrictlySmallerParty(probe: TfsPassengers, target: TfsPassengers): boolean {
  const [p, t] = [tuple(probe), tuple(target)];
  if (!p.every((v, i) => v <= t[i]!)) return false;
  return partySize(probe) >= 1 && partySize(probe) < partySize(target);
}

/**
 * Identifies the route+dates a probe ran, so the guard can tell "the same cell,
 * smaller party" (a valid monotonicity probe) from "a different cell" (not one),
 * and can reject a canary that is secretly the query under test.
 */
export function cellKeyOf(query: TfsQuery): string {
  const legs = query.segments.map((s) => `${s.fromAirport}>${s.toAirport}@${s.date}`).join('|');
  return `${query.trip}/${query.seat}/${legs}`;
}

/**
 * The result of one probe request. It reports the passenger tuple and cell it
 * ACTUALLY ran — not the ones it was asked to run — which is what lets the guard
 * verify a probe rather than trust it. This is the whole reason the dependency
 * is not a `Promise<boolean>`.
 */
export interface PartyProbe {
  /** The passenger tuple this probe actually queried. */
  passengers: TfsPassengers;
  /** The route+dates this probe actually queried (see cellKeyOf). */
  cellKey: string;
  /** Did the probe render priced itineraries? */
  foundFlights: boolean;
}

export type UnverifiedReason =
  /** No canary was run at all (no dependency wired, or no request budget). */
  | 'canary_absent'
  /** The canary ran at a DIFFERENT party size than the query it must vouch for.
   *  A 1-adult canary is not cover for a 5-passenger query: it exercises a
   *  channel Google is not gating. */
  | 'canary_party_mismatch'
  /** The canary ran the query's own cell, so it is not an independent control:
   *  re-observing the target's emptiness teaches us nothing about the channel. */
  | 'canary_is_target'
  /** The canary's known-good cell came back EMPTY at this party size. The
   *  channel is gated or blocked for this party — every empty page it serves at
   *  this size is suspect, including the target's. THIS is what the >=4 gate
   *  trips. */
  | 'canary_empty'
  /** Party >= 2 and empty, but no monotonicity probe was run. */
  | 'monotonicity_probe_missing'
  /** The monotonicity probe did not run a strict sub-party of the same cell, so
   *  it cannot support the inference. */
  | 'monotonicity_probe_invalid'
  /** The target is empty at N passengers but a SMALLER party found priced
   *  itineraries on the same cell. See judgeEmptyResult. */
  | 'monotonicity_violation';

/**
 * A verdict on an empty browser page. `no_options` may be recorded if and only
 * if this is `confirmed` — that is the structural invariant the orchestrator
 * relies on, and the reason this is a tagged union rather than a boolean.
 */
export type EmptyResultVerdict =
  | { kind: 'confirmed'; partySize: number; canaryCell: string }
  | { kind: 'unverified'; reason: UnverifiedReason };

/** Below this, there is no smaller party to probe, so the canary alone governs. */
export const MIN_PARTY_FOR_MONOTONICITY_PROBE = 2;

/** Should we spend a request on a monotonicity probe for this query? */
export function needsMonotonicityProbe(query: TfsQuery): boolean {
  return partySize(query.passengers) >= MIN_PARTY_FOR_MONOTONICITY_PROBE;
}

/**
 * Decide whether an empty browser result has EARNED the claim "no flights".
 *
 * Every gate below fails CLOSED: anything short of a fully corroborated empty
 * yields `unverified`, which the caller must map to a non-market failure
 * (availability undefined / throttled), never to `no_options`.
 *
 * ON THE STRENGTH OF THE MONOTONICITY RULE — stated precisely, because this
 * module exists to stop weak propositions from masquerading as strong ones and
 * it would be self-defeating to do that here:
 *
 *   The INVARIANT is airtight: seats(N) is a subset of seats(N-1). An itinerary
 *   that seats 5 necessarily seats 4. Availability cannot GROW with the party.
 *
 *   The INFERENCE in the direction we can cheaply probe is not a proof. Target
 *   empty at N + a smaller party priced on the same cell is consistent with TWO
 *   worlds: (a) Google fabricated the N-pax zero, or (b) every itinerary that
 *   day genuinely has fewer than N seats left. (b) is a legitimate sold-out.
 *   We cannot distinguish them from outside.
 *
 *   We therefore treat it as a HARD VETO anyway, and that is a deliberate,
 *   costed choice: a wrong `unverified` costs us the word "sold out" on a cell
 *   where we should have said "unknown", while a wrong `no_options` is the P0 bug
 *   that sent a real person a wall of 17 fabricated sold-outs. Given a gate that
 *   is PROVEN to fabricate >= 4-pax zeros on every date, world (a) is also
 *   overwhelmingly the likely one.
 *
 *   THE PRICE, STATED PLAINLY: for party >= 2 this makes `no_options` reachable
 *   only when the cell is empty for a SMALLER party too — i.e. when the route is
 *   effectively not flying that day. A genuine "sold out for a family of 5, but
 *   singles can still book" now reports `unverified`, not `no_options`. We are
 *   not losing a capability we had; while the >=4 gate is up we could never
 *   distinguish that case anyway, and this makes the pipeline say so instead of
 *   guessing. Revisit if a channel without the gate is found.
 */
export function judgeEmptyResult(input: {
  query: TfsQuery;
  /** The party-MATCHED canary against a known-good reference cell. */
  canary: PartyProbe | null;
  /** The strictly-smaller-party probe against the query's OWN cell. */
  monotonicity: PartyProbe | null;
}): EmptyResultVerdict {
  const { query, canary, monotonicity } = input;
  const targetCell = cellKeyOf(query);

  if (!canary) return { kind: 'unverified', reason: 'canary_absent' };

  // The 45a invariant. A canary at any other party size exercises a channel
  // Google is not gating, so it can attest to nothing about the one we used.
  if (!samePartyTuple(canary.passengers, query.passengers)) {
    return { kind: 'unverified', reason: 'canary_party_mismatch' };
  }
  if (canary.cellKey === targetCell) {
    return { kind: 'unverified', reason: 'canary_is_target' };
  }
  if (!canary.foundFlights) {
    return { kind: 'unverified', reason: 'canary_empty' };
  }

  if (needsMonotonicityProbe(query)) {
    if (!monotonicity) return { kind: 'unverified', reason: 'monotonicity_probe_missing' };
    const valid =
      monotonicity.cellKey === targetCell &&
      isStrictlySmallerParty(monotonicity.passengers, query.passengers);
    if (!valid) return { kind: 'unverified', reason: 'monotonicity_probe_invalid' };
    if (monotonicity.foundFlights) {
      return { kind: 'unverified', reason: 'monotonicity_violation' };
    }
  }

  return { kind: 'confirmed', partySize: partySize(query.passengers), canaryCell: canary.cellKey };
}
