/**
 * Live two-tier guard for ticket-tracker-zfj.
 *
 * WHAT WAS ACTUALLY BROKEN (measured 2026-07-11, not inferred):
 * navigateGoogleFlightsUrl judged success purely on the presence of [data-gs].
 * Google's genuine "No options matching your search" page has no [data-gs]
 * either — so a page where Google ANSWERED the query was indistinguishable from
 * one that never loaded. The multi-passenger branch of the browser adapter then
 * filed that answer as `unsupported_query`, whose documented meaning is "we
 * declined to look". The pipeline was therefore disclaiming a query it had in
 * fact run, and the family trip could be neither priced nor honestly marked
 * sold out.
 *
 * GROUND TRUTH for LAX->AKL 2026-12-08 / 2026-12-31 (real Google, verified in
 * the container's headless Chromium AND a real desktop Chrome on a residential
 * IP — the browser tier is NOT fingerprint-blocked):
 *
 *   1 adult             -> $845     |  3 adults -> $2,535  |  5 adults -> $4,120
 *   3 adults + 1 child  -> $3,296
 *   3 adults + 2 children -> EITHER "No options matching your search"
 *                            OR only 2-stop 46-hour routings at $27,997+
 *   3 adults + 2 children on 2026-12-10 / 2026-12-28 -> $3,725 (8 results)
 *
 * i.e. the cheap nonstop inventory that prices at $845/adult cannot seat this
 * 5-person party at all; Google's answer for it legitimately FLIPS between
 * "no options" and "only absurd routings" from one request to the next.
 *
 * That nondeterminism is why this file asserts INVARIANTS rather than a
 * specific availability: any assertion of the form "the family query returns
 * no_options" would be flaky by construction. What must hold on every possible
 * answer is that the pipeline never lies about what it saw.
 *
 * Gated behind RUN_LIVE_SCRAPE=1: hits Google and drives a real browser.
 */
import { describe, it, expect } from 'vitest';
import { runTwoTierGoogleFlights } from './dataplane-integration';
import type { FlightSearchParams } from './navigate';

const LIVE = process.env.RUN_LIVE_SCRAPE === '1';

const PAIR: FlightSearchParams = {
  origin: 'LAX',
  destination: 'AKL',
  dateFrom: new Date('2026-12-08'),
  dateTo: new Date('2026-12-31'),
  cabinClass: 'economy',
  tripType: 'round_trip',
  currency: 'USD',
  country: 'US',
};

const NO_FILTERS = {} as Parameters<typeof runTwoTierGoogleFlights>[0]['filters'];

describe.skipIf(!LIVE)('live two-tier: the 5-person family, LAX->AKL Dec 8-31 2026', () => {
  it('never reports a market verdict it did not earn, whatever Google answers', async () => {
    const result = await runTwoTierGoogleFlights({
      passengers: { adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 0 },
      pairParams: PAIR,
      filters: NO_FILTERS,
      countryProfile: undefined,
      proxyUrl: undefined,
      travelDateFallback: '2026-12-08',
      browserBudget: 3,
    });

    console.log('[live] family query ->', JSON.stringify({
      availability: result.availability,
      failureReason: result.failureReason,
      tier: result.tier,
      canaryOk: result.canaryOk,
      priceCount: result.prices.length,
      cheapest: result.prices.length ? Math.min(...result.prices.map((p) => p.price)) : null,
    }));

    // INVARIANT 1 — the ticket-tracker-uwj rule. `no_options` is a claim that we
    // checked the market and it is empty. It may ONLY be made when the canary
    // independently confirmed the route still has inventory; otherwise a
    // throttled browser gets recorded as "sold out" and poisons the history.
    if (result.availability === 'no_options') {
      expect(result.canaryOk).toBe(true);
    }

    // INVARIANT 2 — `available` is a claim that we found bookable flights. It is
    // only honest if we actually have prices to show for it.
    if (result.availability === 'available') {
      expect(result.prices.length).toBeGreaterThan(0);
    }

    // INVARIANT 3 — the ticket-tracker-njl rule, and the reason the q= fallback
    // is suppressed for multi-passenger queries. The q= URL carries NO passenger
    // count, so it prices ONE ADULT. If a party total ever comes back at or near
    // the single-adult fare ($845 on this route), we have silently priced the
    // wrong trip. 3 adults alone are $2,535, so any 5-person total below ~$2,000
    // is proof of an under-priced party, not a bargain.
    for (const p of result.prices) {
      expect(p.price).toBeGreaterThan(2_000);
    }
  }, 300_000);
});
