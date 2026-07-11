import { describe, expect, it, vi } from 'vitest';
import { orchestrateScrape, type OrchestratorDeps } from './orchestrator';
import type { TfsQuery } from './tfs-builder';
import type { DataplaneFlight, SsrParseResult } from './types';

// oracle: the tier-routing, canary, and budget rules encoded here come directly
// from live measurements on 2026-07-10 (see design doc walking-skeleton section
// + .research/05-design-review.md): (a) any children>0 query ALWAYS defers out
// of SSR, so it must skip tier-1 and go straight to browser; (b) a soft-blocked
// browser returns clean "No results" pages indistinguishable from genuine
// no-availability, so no_options may ONLY be recorded when a same-run canary
// (a known-inventory adults-only query) succeeds; (c) the browser tier has a
// hard per-run budget. These are behavioral requirements, not implementation echoes.

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

describe('orchestrateScrape canary guard (the anti-corruption rule)', () => {
  it('records no_options ONLY when the canary confirms inventory is visible', async () => {
    // browser returns empty, canary SUCCEEDS => genuine no-availability
    const d = deps({
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      canaryHasInventory: vi.fn(async () => true),
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    expect(r.availability).toBe('no_options');
    expect(r.flights).toHaveLength(0);
  });

  it('records THROTTLED (not no_options) when the browser is empty AND canary fails', async () => {
    // This is the measured failure mode: soft-blocked browser serves empty
    // pages; canary (known-good query) also comes back empty => we are blocked,
    // NOT out of inventory. Recording no_options here would corrupt history.
    const d = deps({
      fetchBrowser: vi.fn(async () => ({ status: 'ok' as const, flights: [] })),
      canaryHasInventory: vi.fn(async () => false),
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    expect(r.availability).toBe('throttled');
    expect(r.availability).not.toBe('no_options');
  });

  it('does not run the canary when the browser already found flights', async () => {
    const canary = vi.fn(async () => true);
    const d = deps({ canaryHasInventory: canary });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    expect(r.availability).toBe('available');
    expect(canary).not.toHaveBeenCalled();
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
      canaryHasInventory: vi.fn(async () => true),
    });
    const r = await orchestrateScrape(RT_FAMILY, d, { browserBudget: 5 });
    // one browser fetch + one canary fetch = 2 browser-tier requests consumed
    expect(r.browserRequestsUsed).toBe(2);
  });
});
