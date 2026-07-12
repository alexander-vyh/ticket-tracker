/**
 * Variation-search grid expansion (ticket-tracker-izy).
 *
 * The product's core value is searching a NEIGHBOURHOOD — nearby dates, alternate
 * NZ gateways, different route shapes — to find WHERE availability and good prices
 * exist, rather than tracking one fixed itinerary. This module is the pure,
 * deterministic core of that: it turns a VariationSpec into a bounded list of
 * candidate itineraries that the scrape layer then prices.
 *
 * Two hard-won rules encoded here (both cost real money to learn on 2026-07-11):
 *
 *  1. PRICE ROUND TRIPS — never sum two one-ways. One-way fares are priced
 *     punitively; a live LAX↔AKL check showed a round trip at $995/adult while the
 *     same journey as two one-ways summed to ~$1,360. So 'round_trip' is a
 *     first-class shape whose price comes from ONE round-trip query. The
 *     'two_one_ways' shape still exists because one-way legs can be BOOKABLE when
 *     the round trip has no inventory (the 5-seat peak-date wall) — but it is a
 *     fallback for availability, not a pricing strategy.
 *
 *  2. DATE CHOICE DOMINATES. The same LAX→AKL Delta nonstop was $916 on Dec 15 and
 *     $1,888 on Dec 12; the cheapest round trip moved $745 → $1,537 on stay-window
 *     alone. A fixed-date search is therefore near-useless — the grid is the point.
 *
 * The combo cap SAMPLES EVENLY across the window rather than truncating, so a
 * capped grid still spans the whole neighbourhood instead of only its earliest
 * dates. Whatever the cap drops is reported, never silently swallowed.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** How the itinerary is shaped — and therefore how it must be priced. */
export type RouteShape =
  /** One round-trip query, in and out of the SAME gateway. Priced as a unit. */
  | 'round_trip'
  /** In one gateway, out another (e.g. in AKL, out CHC). One multi-city query. */
  | 'open_jaw'
  /** Two independent one-way queries. Availability fallback, not a cheap shape. */
  | 'two_one_ways';

export interface VariationSpec {
  /** Home airport, e.g. LAX. */
  origin: string;
  /** Arrival gateways to try, e.g. ['AKL','CHC','WLG','ZQN']. */
  destinations: string[];
  /** Inclusive ISO (YYYY-MM-DD) window for the outbound date. */
  departWindow: { from: string; to: string };
  /** Inclusive ISO window for the return date. */
  returnWindow: { from: string; to: string };
  /** Inclusive stay-length range in nights; filters the (depart, return) pairs. */
  stayNights: { min: number; max: number };
  /** Shapes to generate. */
  shapes: RouteShape[];
  /** Hard cap on generated candidates. Excess is dropped by EVEN SAMPLING. */
  maxCombos: number;
  /**
   * Step in days between sampled dates within each window (default 1 = every day).
   * Raise to coarsen a wide window before the cap has to bite.
   */
  dateStepDays?: number;
}

/** One concrete itinerary to price. */
export interface Candidate {
  /** Stable key — same itinerary always yields the same id (dedupe/persistence). */
  id: string;
  shape: RouteShape;
  outbound: { from: string; to: string; date: string };
  inbound: { from: string; to: string; date: string };
  stayNights: number;
}

export interface VariationGrid {
  candidates: Candidate[];
  /** Total combos before the cap was applied. */
  totalBeforeCap: number;
  /** How many the cap dropped (0 when everything fit). Never silently truncated. */
  droppedByCap: number;
}

function toUtcDay(iso: string): Date {
  return new Date(iso + 'T00:00:00Z');
}

function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

function nightsBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** Inclusive list of ISO days across [from, to], sampled every `step` days. */
function daysInWindow(from: string, to: string, step: number): string[] {
  const start = toUtcDay(from);
  const end = toUtcDay(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (end.getTime() < start.getTime()) return [];
  const out: string[] = [];
  const span = nightsBetween(start, end);
  for (let i = 0; i <= span; i += Math.max(1, step)) {
    out.push(toIsoDay(addDays(start, i)));
  }
  return out;
}

/**
 * Pick `k` items spread evenly across `items` (always keeping the first and, when
 * k > 1, the last). Used so a capped grid still spans the whole neighbourhood
 * instead of collapsing onto its earliest dates.
 */
function sampleEvenly<T>(items: T[], k: number): T[] {
  if (k >= items.length) return items;
  if (k <= 0) return [];
  if (k === 1) return [items[0]!];
  const out: T[] = [];
  const stride = (items.length - 1) / (k - 1);
  for (let i = 0; i < k; i++) {
    out.push(items[Math.round(i * stride)]!);
  }
  return out;
}

function candidateId(c: Omit<Candidate, 'id'>): string {
  const o = c.outbound;
  const i = c.inbound;
  return `${c.shape}:${o.from}-${o.to}@${o.date}:${i.from}-${i.to}@${i.date}`;
}

/**
 * Expand a VariationSpec into a bounded, evenly-sampled grid of candidates.
 *
 * Pairs are formed from the depart × return windows, then filtered to the
 * stay-length range (so a 3-week trip doesn't generate 2-day combos). Each
 * surviving pair is emitted once per requested shape:
 *
 *  - round_trip    → out LAX→G, back G→LAX (same gateway G)
 *  - two_one_ways  → same legs as round_trip, but priced as two independent
 *                    one-ways (availability fallback — see the module header)
 *  - open_jaw      → out LAX→G1, back G2→LAX for every ORDERED pair G1≠G2, so
 *                    "fly into Auckland, home from Christchurch" is covered.
 */
export function expandVariationGrid(spec: VariationSpec): VariationGrid {
  const step = spec.dateStepDays ?? 1;
  const departDays = daysInWindow(spec.departWindow.from, spec.departWindow.to, step);
  const returnDays = daysInWindow(spec.returnWindow.from, spec.returnWindow.to, step);
  const gateways = spec.destinations.filter((g) => g.length > 0);

  const all: Candidate[] = [];

  for (const dep of departDays) {
    for (const ret of returnDays) {
      const nights = nightsBetween(toUtcDay(dep), toUtcDay(ret));
      // HARD invariant, independent of the configured range: you cannot fly home
      // before you leave. A caller passing a negative stayNights.min must not be
      // able to conjure a time-travelling itinerary.
      if (nights < 0) continue;
      // Then the caller's stay-length preference.
      if (nights < spec.stayNights.min || nights > spec.stayNights.max) continue;

      for (const shape of spec.shapes) {
        if (shape === 'open_jaw') {
          // Every ORDERED gateway pair (in G1, out G2) with G1 != G2.
          for (const gIn of gateways) {
            for (const gOut of gateways) {
              if (gIn === gOut) continue;
              const base = {
                shape,
                outbound: { from: spec.origin, to: gIn, date: dep },
                inbound: { from: gOut, to: spec.origin, date: ret },
                stayNights: nights,
              };
              all.push({ id: candidateId(base), ...base });
            }
          }
          continue;
        }

        // round_trip and two_one_ways share the same legs; only pricing differs.
        for (const g of gateways) {
          const base = {
            shape,
            outbound: { from: spec.origin, to: g, date: dep },
            inbound: { from: g, to: spec.origin, date: ret },
            stayNights: nights,
          };
          all.push({ id: candidateId(base), ...base });
        }
      }
    }
  }

  const totalBeforeCap = all.length;
  const cap = Math.max(0, spec.maxCombos);
  const candidates = sampleEvenly(all, cap);

  return {
    candidates,
    totalBeforeCap,
    droppedByCap: totalBeforeCap - candidates.length,
  };
}
