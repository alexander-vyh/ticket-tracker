/**
 * Two-tier Google Flights scrape orchestrator.
 *
 * Encodes the operating rules discovered in the 2026-07-10 walking skeleton
 * (design doc + .research/05-design-review.md):
 *
 *  - Tier 1 (SSR, cheap, throttle-resilient) can price adults-only queries but
 *    Google defers EVERY children>0 query out of the SSR payload. So a query
 *    with any children skips tier 1 and goes straight to tier 2.
 *  - Tier 2 (headless browser + LLM) can price anything but Google soft-blocks
 *    a browser fingerprint after a modest number of requests, serving clean
 *    "No results" pages that are BYTE-IDENTICAL to genuine no-availability.
 *    Therefore an empty browser result can only be trusted as `no_options`
 *    when a same-run CANARY (a known-inventory adults-only query) still returns
 *    flights. If the canary is also empty, we are throttled, not sold out —
 *    recording `no_options` there would poison the price/availability history.
 *  - Tier 2 has a hard per-run request budget; when exhausted the query is
 *    reported `throttled`, never `no_options`.
 */
import type { DataplaneFlight, SsrParseResult } from './types';
import type { TfsQuery } from './tfs-builder';

export type BrowserFetchResult =
  | { status: 'ok'; flights: DataplaneFlight[] }
  | { status: 'error'; reason: string };

export interface OrchestratorDeps {
  /** Tier 1: plain-HTTPS SSR fetch + parse. */
  fetchSsr: (query: TfsQuery) => Promise<SsrParseResult>;
  /** Tier 2: headless browser navigation + LLM extraction. */
  fetchBrowser: (query: TfsQuery) => Promise<BrowserFetchResult>;
  /**
   * Canary: does a known-inventory adults-only variant of this route still
   * return flights through the browser tier right now? Only consulted to
   * disambiguate an empty browser result. Consumes one browser request.
   */
  canaryHasInventory?: (query: TfsQuery) => Promise<boolean>;
}

export interface OrchestratorOptions {
  /** Max browser-tier requests this scrape may consume (fetch + canary). */
  browserBudget: number;
}

export type Availability = 'available' | 'no_options' | 'throttled';
export type Tier = 'ssr' | 'browser_llm' | 'ssr+browser_llm';

export interface OrchestratorResult {
  flights: DataplaneFlight[];
  availability: Availability;
  tier: Tier;
  browserRequestsUsed: number;
  note?: string;
}

function hasChildrenOrInfants(q: TfsQuery): boolean {
  const p = q.passengers;
  return (p.children ?? 0) + (p.infantsInSeat ?? 0) + (p.infantsOnLap ?? 0) > 0;
}

export async function orchestrateScrape(
  query: TfsQuery,
  deps: OrchestratorDeps,
  opts: OrchestratorOptions,
): Promise<OrchestratorResult> {
  let browserUsed = 0;
  let usedSsr = false;

  // Tier 1 — only worth attempting when SSR can actually serve the query.
  if (!hasChildrenOrInfants(query)) {
    usedSsr = true;
    const ssr = await deps.fetchSsr(query);
    if (ssr.status === 'ok' && ssr.flights.length > 0) {
      return {
        flights: ssr.flights,
        availability: 'available',
        tier: 'ssr',
        browserRequestsUsed: 0,
      };
    }
    // ssr.status 'ok' with zero flights on an adults-only query is a trustworthy
    // no_options (SSR is not fingerprint-throttled); but fall through to the
    // browser tier for a second opinion when budget allows, since SSR empties
    // are rare. 'deferred'/'error' always fall through.
  }

  // Tier 2 — browser + LLM.
  const tier: Tier = usedSsr ? 'ssr+browser_llm' : 'browser_llm';

  if (opts.browserBudget - browserUsed <= 0) {
    return {
      flights: [],
      availability: 'throttled',
      tier,
      browserRequestsUsed: browserUsed,
      note: 'browser budget exhausted before fetch',
    };
  }

  const browser = await deps.fetchBrowser(query);
  browserUsed += 1;

  if (browser.status === 'ok' && browser.flights.length > 0) {
    return { flights: browser.flights, availability: 'available', tier, browserRequestsUsed: browserUsed };
  }

  // Empty (or errored) browser result — cannot be trusted without the canary.
  const canaryAvailable = deps.canaryHasInventory && opts.browserBudget - browserUsed > 0;
  if (!canaryAvailable) {
    return {
      flights: [],
      availability: 'throttled',
      tier,
      browserRequestsUsed: browserUsed,
      note: 'empty browser result, no canary budget to disambiguate',
    };
  }

  const inventoryVisible = await deps.canaryHasInventory!(query);
  browserUsed += 1;

  return {
    flights: [],
    // canary sees inventory => our empty result is a genuine no-availability;
    // canary also empty => we are throttled, NOT sold out.
    availability: inventoryVisible ? 'no_options' : 'throttled',
    tier,
    browserRequestsUsed: browserUsed,
    note: inventoryVisible
      ? 'browser empty, canary confirmed inventory visible => genuine no_options'
      : 'browser empty AND canary empty => soft-blocked, not sold out',
  };
}
