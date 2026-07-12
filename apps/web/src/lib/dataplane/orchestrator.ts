/**
 * Two-tier Google Flights scrape orchestrator.
 *
 * Encodes the operating rules discovered in the 2026-07-10 walking skeleton
 * (design doc + .research/05-design-review.md):
 *
 *  - Tier 1 (SSR, cheap, throttle-resilient) can price adults-only queries but
 *    Google defers EVERY children>0 query out of the SSR payload. So a query
 *    with any children skips tier 1 and goes straight to tier 2.
 *  - Tier 2 (headless browser + LLM) can price anything, but Google serves clean
 *    "No results" pages that are BYTE-IDENTICAL to genuine no-availability —
 *    both when soft-blocking a browser fingerprint AND, as of 2026-07-11, on
 *    every date for any party of >= 4 passengers (a fabricated party-size gate;
 *    see no-options-guard.ts for the evidence). An empty tier-2 page is
 *    therefore an observation about a WEB PAGE, never on its own a claim about
 *    the market.
 *  - Consequently `no_options` is minted here in exactly ONE place, and only
 *    against a `confirmed` EmptyResultVerdict from no-options-guard.ts. Anything
 *    less — no canary, a canary at the wrong party size, an empty canary, or a
 *    smaller party finding flights the full party could not — is `throttled`.
 *  - Tier 2 has a hard per-run request budget; when exhausted the query is
 *    reported `throttled`, never `no_options`.
 */
import type { DataplaneFlight, SsrParseResult } from './types';
import type { TfsQuery } from './tfs-builder';
import {
  judgeEmptyResult,
  needsMonotonicityProbe,
  type EmptyResultVerdict,
  type PartyProbe,
} from './no-options-guard';

export type BrowserFetchResult =
  | { status: 'ok'; flights: DataplaneFlight[] }
  | { status: 'error'; reason: string };

export interface OrchestratorDeps {
  /** Tier 1: plain-HTTPS SSR fetch + parse. */
  fetchSsr: (query: TfsQuery) => Promise<SsrParseResult>;
  /** Tier 2: headless browser navigation + LLM extraction. */
  fetchBrowser: (query: TfsQuery) => Promise<BrowserFetchResult>;
  /**
   * CANARY. Runs a KNOWN-GOOD reference cell through the SAME TIER and at the
   * SAME PARTY SIZE as the query it must vouch for, and reports back the party
   * and cell it actually ran (see PartyProbe) so the guard can VERIFY the match.
   *
   * The party-matching is the entire point and is not negotiable: Google gates
   * parties of >= 4 with a fabricated empty page, so a 1-adult canary is green
   * all night and would certify every fabricated 5-passenger zero as a real
   * sold-out. Consumes one browser request.
   */
  probeCanary?: (query: TfsQuery) => Promise<PartyProbe>;
  /**
   * MONOTONICITY PROBE. Re-runs the query's OWN cell at a strictly smaller
   * party. If the smaller party finds flights where the full party found none,
   * the full-party zero has not earned the name `no_options`. Consumes one
   * browser request; only fired for parties >= 2 that came back empty — i.e.
   * only when we are about to make a market claim.
   */
  probeMonotonicity?: (query: TfsQuery) => Promise<PartyProbe>;
}

export interface OrchestratorOptions {
  /** Max browser-tier requests this scrape may consume (fetch + canary). */
  browserBudget: number;
  /**
   * Force the browser tier even for an adults-only query that the SSR tier
   * could price. SSR returns only Google's top-~5 ranked "best" flights, which
   * structurally excludes cheaper one-stop carriers (Fiji via NAN, Qantas via
   * SYD); the browser tier renders the full list. Default false keeps SSR as
   * the cheap high-frequency movement signal. (ticket-tracker-k5m.8)
   */
  deepSearch?: boolean;
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

  // Tier 1 — only worth attempting when SSR can actually serve the query AND
  // the caller has not requested a deep (full-carrier) search. SSR's top-5
  // 'best' set hides one-stop alternatives, so deepSearch skips straight to the
  // browser tier. (ticket-tracker-k5m.8)
  if (!hasChildrenOrInfants(query) && !opts.deepSearch) {
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

  // Empty (or errored) browser result. An empty PAGE is not an empty MARKET, and
  // everything below exists to keep those two apart. Each probe is attempted only
  // if budget remains; a probe we could not afford stays `null`, and a `null`
  // probe can only ever produce an `unverified` verdict — budget starvation
  // therefore fails closed, never into a fabricated sold-out.
  let canary: PartyProbe | null = null;
  let monotonicity: PartyProbe | null = null;

  if (deps.probeCanary && opts.browserBudget - browserUsed > 0) {
    canary = await deps.probeCanary(query);
    browserUsed += 1;
  }

  // Only spend the second request when we are actually about to make a market
  // claim: the canary has to have passed, and there has to be a smaller party to
  // probe. A party of 1 has none, so the canary alone governs it.
  const canaryPassed = canary?.foundFlights === true;
  if (
    canaryPassed &&
    needsMonotonicityProbe(query) &&
    deps.probeMonotonicity &&
    opts.browserBudget - browserUsed > 0
  ) {
    monotonicity = await deps.probeMonotonicity(query);
    browserUsed += 1;
  }

  const verdict: EmptyResultVerdict = judgeEmptyResult({ query, canary, monotonicity });

  return {
    flights: [],
    // THE INVARIANT: `no_options` is reachable from exactly one expression in
    // this codebase, and only when the guard returns `confirmed`.
    availability: verdict.kind === 'confirmed' ? 'no_options' : 'throttled',
    tier,
    browserRequestsUsed: browserUsed,
    note:
      verdict.kind === 'confirmed'
        ? `browser empty; party-matched canary (${verdict.partySize} pax, ${verdict.canaryCell}) saw inventory and no smaller party beat it => genuine no_options`
        : `browser empty and NOT confirmed sold out (${verdict.reason}) => reporting throttled, not no_options`,
  };
}
