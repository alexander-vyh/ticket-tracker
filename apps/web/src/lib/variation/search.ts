/**
 * Variation search runner (ticket-tracker-izy).
 *
 * Takes a VariationSpec, expands it into a bounded grid (see ./grid.ts), prices
 * every candidate through an injected pricing function, and returns a matrix of
 * (itinerary → total party price + availability) plus the cheapest bookable cell.
 *
 * Pricing is DEPENDENCY-INJECTED (`priceQuery`) so the whole runner is testable
 * without touching Google. In production it is wired to the two-tier data plane
 * (SSR tier-1 for the cheap movement signal, budgeted browser tier-2 for exact
 * party pricing) — see orchestrator.ts / dataplane-integration.ts.
 *
 * THE SHAPE DETERMINES THE QUERY, and getting that wrong costs real money:
 *   round_trip   → ONE round-trip query. Never two one-ways summed: live LAX↔AKL
 *                  priced $995/adult as a round trip vs ~$1,360 as summed one-ways.
 *   open_jaw     → ONE multi-city query (in one gateway, out another).
 *   two_one_ways → TWO one-way queries, summed. This exists ONLY because one-way
 *                  legs can be bookable when the round trip has no inventory (the
 *                  5-seat peak-date wall). Both legs must price, or the shape is
 *                  unbookable — a half-priced trip is not a trip.
 *
 * The request budget is a hard stop, and anything it prevents us from pricing is
 * REPORTED as skipped, never silently dropped — a truncated sweep that looks
 * complete is worse than one that admits its gaps.
 */
import type { TfsQuery, TfsSeat } from '../dataplane/tfs-builder';
import type { Availability } from '../dataplane/orchestrator';
import type { Candidate, VariationSpec } from './grid';
import { expandVariationGrid } from './grid';

export interface PartyPassengers {
  adults: number;
  children: number;
  infantsInSeat: number;
  infantsOnLap: number;
}

/** What the injected pricer returns for a single TfsQuery. */
export interface QueryPrice {
  /** Cheapest total for the whole party, or null when nothing was bookable. */
  total: number | null;
  currency: string | null;
  availability: Availability;
  /** Browser-tier requests this query consumed (0 for a pure SSR hit). */
  requestsUsed: number;
}

export type PriceQuery = (query: TfsQuery) => Promise<QueryPrice>;

export interface VariationCell {
  candidate: Candidate;
  /** Total party price for the whole itinerary, or null if not bookable/priced. */
  total: number | null;
  currency: string | null;
  availability: Availability;
  /** Per-leg detail for two_one_ways (undefined for single-query shapes). */
  legs?: QueryPrice[];
  requestsUsed: number;
}

export interface VariationResult {
  cells: VariationCell[];
  /** Cheapest cell whose availability is 'available'. Null if none priced. */
  best: VariationCell | null;
  /** Combos the grid produced before its own cap. */
  totalBeforeCap: number;
  /** Combos the grid's cap dropped. */
  droppedByCap: number;
  /** Candidates we never priced because the request budget ran out. */
  skippedForBudget: number;
  requestsUsed: number;
}

export interface VariationSearchOptions {
  seat?: TfsSeat;
  /** Hard ceiling on pricing requests across the whole sweep. */
  requestBudget: number;
}

/**
 * Map one candidate onto the tfs queries needed to price it.
 * Returns ONE query for round_trip / open_jaw, TWO for two_one_ways.
 */
export function candidateToTfsQueries(
  candidate: Candidate,
  passengers: PartyPassengers,
  seat: TfsSeat = 'economy',
): TfsQuery[] {
  const { outbound, inbound } = candidate;
  const out = { date: outbound.date, fromAirport: outbound.from, toAirport: outbound.to };
  const back = { date: inbound.date, fromAirport: inbound.from, toAirport: inbound.to };

  if (candidate.shape === 'two_one_ways') {
    return [
      { trip: 'one-way', seat, segments: [out], passengers },
      { trip: 'one-way', seat, segments: [back], passengers },
    ];
  }

  // round_trip and open_jaw are both ONE query — the difference is only whether
  // the return leg reverses the outbound (the tfs-builder validates that).
  const trip = candidate.shape === 'open_jaw' ? 'open-jaw' : 'round-trip';
  return [{ trip, seat, segments: [out, back], passengers }];
}

/** Worst-case availability across legs: throttled > no_options > available. */
function combineAvailability(parts: Availability[]): Availability {
  if (parts.some((a) => a === 'throttled')) return 'throttled';
  if (parts.some((a) => a === 'no_options')) return 'no_options';
  return 'available';
}

/**
 * Price one candidate. For two_one_ways both legs must be available and priced,
 * otherwise the itinerary as a whole is not bookable and carries no total.
 */
async function priceCandidate(
  candidate: Candidate,
  passengers: PartyPassengers,
  seat: TfsSeat,
  priceQuery: PriceQuery,
): Promise<VariationCell> {
  const queries = candidateToTfsQueries(candidate, passengers, seat);
  const legs: QueryPrice[] = [];
  for (const q of queries) {
    legs.push(await priceQuery(q));
  }

  const requestsUsed = legs.reduce((sum, l) => sum + l.requestsUsed, 0);
  const availability = combineAvailability(legs.map((l) => l.availability));
  const currency = legs.find((l) => l.currency)?.currency ?? null;

  // A total exists only when EVERY leg priced. A half-priced two-one-way trip is
  // not a bookable trip, and must never masquerade as a cheap one.
  const allPriced = legs.every((l) => l.total != null);
  const total =
    allPriced && availability === 'available'
      ? legs.reduce((sum, l) => sum + (l.total ?? 0), 0)
      : null;

  const cell: VariationCell = { candidate, total, currency, availability, requestsUsed };
  if (queries.length > 1) cell.legs = legs;
  return cell;
}

/**
 * Run the whole sweep: expand the grid, price each candidate within budget, and
 * report the cheapest bookable itinerary.
 */
export async function runVariationSearch(
  spec: VariationSpec,
  passengers: PartyPassengers,
  priceQuery: PriceQuery,
  opts: VariationSearchOptions,
): Promise<VariationResult> {
  const seat = opts.seat ?? 'economy';
  const grid = expandVariationGrid(spec);

  const cells: VariationCell[] = [];
  let requestsUsed = 0;
  let skippedForBudget = 0;

  for (const candidate of grid.candidates) {
    if (requestsUsed >= opts.requestBudget) {
      // Out of budget: do NOT price, and do NOT pretend we did.
      skippedForBudget += 1;
      continue;
    }
    const cell = await priceCandidate(candidate, passengers, seat, priceQuery);
    requestsUsed += cell.requestsUsed;
    cells.push(cell);
  }

  if (skippedForBudget > 0) {
    console.log(
      `[variation] request budget ${opts.requestBudget} exhausted — ${skippedForBudget} candidate(s) left unpriced`,
    );
  }
  if (grid.droppedByCap > 0) {
    console.log(
      `[variation] grid cap ${spec.maxCombos} dropped ${grid.droppedByCap} of ${grid.totalBeforeCap} combos (evenly sampled)`,
    );
  }

  const bookable = cells.filter((c) => c.availability === 'available' && c.total != null);
  const best =
    bookable.length === 0
      ? null
      : bookable.reduce((lo, c) => ((c.total ?? Infinity) < (lo.total ?? Infinity) ? c : lo));

  return {
    cells,
    best,
    totalBeforeCap: grid.totalBeforeCap,
    droppedByCap: grid.droppedByCap,
    skippedForBudget,
    requestsUsed,
  };
}
