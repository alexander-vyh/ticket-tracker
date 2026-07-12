import { describe, expect, it, vi } from 'vitest';
import { orchestrateScrape, type OrchestratorDeps } from './orchestrator';
import { cellKeyOf, type PartyProbe } from './no-options-guard';
import type { TfsQuery } from './tfs-builder';
import type { DataplaneFlight, SsrParseResult } from './types';

// oracle: the tier-routing, canary, and budget rules encoded here come from live
// measurements: (a) any children>0 query ALWAYS defers out of SSR, so it must
// skip tier-1 and go straight to browser (2026-07-10); (b) Google serves clean
// "No results" pages indistinguishable from genuine no-availability — both when
// soft-blocking a browser AND, as of 2026-07-11, on EVERY date for any party of
// >= 4 (a fabricated party-size gate: 3 adults -> 8 results, 4 pax -> "No
// options", same tab, same minute). So no_options may ONLY be recorded when a
// canary AT THE SAME PARTY SIZE still sees inventory and no smaller party beats
// the target; (c) the browser tier has a hard per-run budget, and running out of
// it must fail closed. These are behavioral requirements, not implementation echoes.

const RT_ADULTS: TfsQuery = {
  trip: 'round-trip', seat: 'economy',
  segments: [
    { date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2027-01-08', fromAirport: 'AKL', toAirport: 'LAX' },
  ],
  passengers: { adults: 3 },
};
const RT_FAMILY: TfsQuery = { ...RT_ADULTS, passengers: { adults: 3, children: 2 } };

const oneFlight: DataplaneFlight[] = [
  { price: 6448, airlines: ['American'], legs: [{ fromAirport: 'LAX', fromAirportName: 'Los Angeles', toAirport: 'AKL', toAirportName: 'Auckland', departureDate: [2026, 12, 18], departureTime: [13], arrivalDate: [2026, 12, 19], arrivalTime: [7, 30], duration: 800, planeType: '787' }] },
];

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    fetchSsr: vi.fn(async (): Promise<SsrParseResult> => ({ status: 'ok', flights: oneFlight })),
    fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: oneFlight })),
    ...over,
  };
}

describe('orchestrateScrape tier routing', () => {
  it('adults-only query with SSR inventory never touches the browser tier', async () => {
    const d = deps();
    const r = await orchestrateScrape(RT_ADULTS, d, { browserBudget: 5 });
    expect(r.tier).toBe('ssr');
    expect(r.availability).toBe('available');
    expect(r.flights).toHaveLength(1);
    expect(d.fetchBrowser).not.toHaveBeenCalled();
  });

  it('deepSearch forces the browser tier for an adults-only query (skips SSR top-5)', async () => {
    // Without deepSearch this same query is served entirely from SSR (see the
    // test above). deepSearch surfaces one-stop carriers the SSR top-5 hides.
    const d = deps();
    const r = await orchestrateScrape(RT_ADULTS, d, { browserBudget: 5, deepSearch: true });
    expect(d.fetchSsr).not.toHaveBeenCalled();
    expect(d.fetchBrowser).toHaveBeenCalled();
    expect(r.tier).toBe('browser_llm');
    expect(r.availability).toBe('available');
  });

  it('children query skips SSR entirely and uses the browser tier', async () => {
    const d = deps();
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    expect(d.fetchSsr).not.toHaveBeenCalled();
    expect(d.fetchBrowser).toHaveBeenCalled();
    expect(r.tier).toBe('browser_llm');
  });

  it('falls back to browser when SSR defers (adults, heavy query)', async () => {
    const d = deps({ fetchSsr: vi.fn(async () => ({ status: 'deferred' as const })) });
    const r = await orchestrateScrape(RT_ADULTS, d, { browserBudget: 5 });
    expect(d.fetchSsr).toHaveBeenCalled();
    expect(d.fetchBrowser).toHaveBeenCalled();
    expect(r.tier).toBe('ssr+browser_llm');
  });
});

// A canary that faithfully mirrors the guarded query's party, run against a
// reference cell that is NOT the query's own. This is what a CORRECT canary
// looks like; the tests below then attack it.
const REFERENCE_CELL = cellKeyOf({
  ...RT_ADULTS,
  segments: [
    { date: '2026-12-01', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2026-12-22', fromAirport: 'AKL', toAirport: 'LAX' },
  ],
});
const matchedCanary = (foundFlights: boolean) =>
  vi.fn(async (q: TfsQuery): Promise<PartyProbe> => ({
    passengers: { ...q.passengers },
    cellKey: REFERENCE_CELL,
    foundFlights,
  }));
const monotonicityProbe = (foundFlights: boolean) =>
  vi.fn(async (q: TfsQuery): Promise<PartyProbe> => ({
    passengers: { adults: 1 },
    cellKey: cellKeyOf(q),
    foundFlights,
  }));

describe('orchestrateScrape no_options guard (the anti-corruption rule)', () => {
  it('records no_options ONLY when a party-matched canary sees inventory AND no smaller party beats the target', async () => {
    const d = deps({
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      probeCanary: matchedCanary(true),
      probeMonotonicity: monotonicityProbe(false),
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    expect(r.availability).toBe('no_options');
    expect(r.flights).toHaveLength(0);
  });

  it('records THROTTLED (not no_options) when the browser is empty AND the canary is empty', async () => {
    // The measured failure mode: Google serves an empty page for the party, and
    // the known-good reference cell is empty at that same party too => the
    // CHANNEL is gated, we are not out of inventory. no_options here corrupts
    // the availability history and later fires a bogus sold-out -> available alert.
    const d = deps({
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      probeCanary: matchedCanary(false),
      probeMonotonicity: monotonicityProbe(false),
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    expect(r.availability).toBe('throttled');
    expect(r.availability).not.toBe('no_options');
  });

  it('MONOTONICITY: a 5-pax empty that a 1-adult probe beats on the same cell is NEVER no_options', async () => {
    // Availability cannot grow with the party. Even with a green canary, a
    // smaller party out-finding the full party means the zero was not earned.
    const d = deps({
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      probeCanary: matchedCanary(true),
      probeMonotonicity: monotonicityProbe(true),
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    expect(r.availability).toBe('throttled');
    expect(r.availability).not.toBe('no_options');
    expect(r.note).toContain('monotonicity_violation');
  });

  it('a 1-ADULT canary is not valid cover for a 5-passenger query, even though it found flights', async () => {
    // The laundering bug (45a): a 1-adult probe passes Google's >=4 party gate all
    // night, so a naive canary would certify every fabricated 5-pax zero as a real
    // sold-out — worse than no canary, because it puts a green check beside a lie.
    // The orchestrator must reject it on the party mismatch alone.
    const naiveCanary = vi.fn(async (): Promise<PartyProbe> => ({
      passengers: { adults: 1 },
      cellKey: REFERENCE_CELL,
      foundFlights: true,
    }));
    const d = deps({
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      probeCanary: naiveCanary,
      probeMonotonicity: monotonicityProbe(false),
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    expect(r.availability).not.toBe('no_options');
    expect(r.availability).toBe('throttled');
    expect(r.note).toContain('canary_party_mismatch');
  });

  it('does not probe at all when the browser already found flights', async () => {
    const canary = matchedCanary(true);
    const mono = monotonicityProbe(false);
    const d = deps({ probeCanary: canary, probeMonotonicity: mono });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    expect(r.availability).toBe('available');
    expect(canary).not.toHaveBeenCalled();
    expect(mono).not.toHaveBeenCalled();
  });

  it('skips the monotonicity probe once the canary has already failed — the verdict is settled', async () => {
    const mono = monotonicityProbe(false);
    const d = deps({
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      probeCanary: matchedCanary(false),
      probeMonotonicity: mono,
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    expect(r.availability).toBe('throttled');
    expect(mono).not.toHaveBeenCalled();
  });

  it('needs no monotonicity probe for a solo query — there is no smaller party', async () => {
    const mono = monotonicityProbe(false);
    const d = deps({
      fetchSsr: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      probeCanary: matchedCanary(true),
      probeMonotonicity: mono,
    });
    const solo: TfsQuery = { ...RT_ADULTS, passengers: { adults: 1 } };
    const r = await orchestrateScrape(solo, d, { browserBudget: 5 });
    expect(r.availability).toBe('no_options');
    expect(mono).not.toHaveBeenCalled();
  });
});

describe('orchestrateScrape browser budget', () => {
  it('refuses the browser tier when budget is exhausted, returns throttled', async () => {
    const d = deps();
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 0 });
    expect(d.fetchBrowser).not.toHaveBeenCalled();
    expect(r.availability).toBe('throttled');
    expect(r.tier).toBe('browser_llm');
  });

  it('reports how many browser requests it consumed (for the run-level cap)', async () => {
    const d = deps({
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      probeCanary: matchedCanary(true),
      probeMonotonicity: monotonicityProbe(false),
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    // browser fetch + party-matched canary + monotonicity probe = 3
    expect(r.browserRequestsUsed).toBe(3);
  });

  it('budget starvation FAILS CLOSED: too little budget for the monotonicity probe yields throttled, not no_options', async () => {
    // Budget 2 buys the fetch and the canary but not the monotonicity probe. The
    // guard must refuse to confirm on a probe it could not afford to run — a
    // sold-out claim we cannot corroborate is a claim we must not make.
    const mono = monotonicityProbe(false);
    const d = deps({
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      probeCanary: matchedCanary(true),
      probeMonotonicity: mono,
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 2 });
    expect(mono).not.toHaveBeenCalled();
    expect(r.availability).toBe('throttled');
    expect(r.note).toContain('monotonicity_probe_missing');
  });

  it('budget for the fetch alone yields throttled — an uncorroborated empty is never sold out', async () => {
    const d = deps({
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      probeCanary: matchedCanary(true),
      probeMonotonicity: monotonicityProbe(false),
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 1 });
    expect(r.availability).toBe('throttled');
    expect(r.note).toContain('canary_absent');
  });
});
