import type { Page } from 'playwright';
import { launchBrowser, createStealthContext } from './browser';
import { getAirlineUrl } from './airline-urls';
import type { CountryProfile } from './country-profiles';
import {
  CURRENCY_MENTION_PATTERN,
  MIN_CURRENCY_MENTIONS,
  NO_OPTIONS_PHRASES,
  PRICE_TOKEN_PATTERN,
  pageHasRequestedRoute,
  pageRedirectedToHomepage,
  pageShowsNoOptions,
} from './page-verdict';

// Re-exported: these moved to ./page-verdict (navigate.ts drives the browser;
// page-verdict judges what came back) but callers and tests still import them
// from here.
export {
  CURRENCY_MENTION_PATTERN,
  MIN_CURRENCY_MENTIONS,
  PRICE_TOKEN_PATTERN,
  hasFlightPriceSignal,
  pageHasRequestedRoute,
  pageRedirectedToHomepage,
  pageShowsNoOptions,
} from './page-verdict';

/** Random delay between min and max milliseconds */
function randomDelay(min: number, max: number): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

/** Simulate human-like page interaction: mouse moves, scrolls, pauses */
async function simulateHumanBehavior(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };

  // Move mouse to a random spot (humans don't leave cursor at 0,0)
  await page.mouse.move(
    100 + Math.random() * (viewport.width - 200),
    100 + Math.random() * (viewport.height - 200),
    { steps: 5 + Math.floor(Math.random() * 10) }
  );
  await randomDelay(200, 600);

  // Scroll down slightly like a human scanning results
  await page.mouse.wheel(0, 100 + Math.random() * 300);
  await randomDelay(300, 800);

  // Move mouse again
  await page.mouse.move(
    100 + Math.random() * (viewport.width - 200),
    200 + Math.random() * (viewport.height - 400),
    { steps: 3 + Math.floor(Math.random() * 8) }
  );
  await randomDelay(100, 400);
}

/**
 * Expand Google Flights' collapsed result list before the DOM is read.
 *
 * Google renders only its top ~5-8 ranked "Best" flights plus a "View more
 * flights" button; the cheaper one-stop carriers a flexible trip needs (Fiji
 * Airways via NAN, Qantas via SYD, Hawaiian via HNL) sit behind that button and
 * load client-side only. Without expanding it the extractor never sees them —
 * the ticket-tracker-k5m.8 root cause. This runs only on the browser tier,
 * which is already the "pay for depth" path (SSR top-5 stays the cheap
 * high-frequency movement signal).
 *
 * Best-effort and fail-open: matches the expander by several localized-label /
 * role candidates (Google's markup drifts over time and by locale), clicks up
 * to `maxClicks` times waiting for new rows each time, and on any error or a
 * missing button simply leaves the current results in place. Expansion is extra
 * depth, never a hard requirement — a throw here must not fail the navigation.
 */
async function expandRenderedFlights(page: Page, maxClicks = 3): Promise<number> {
  let clicks = 0;
  for (let i = 0; i < maxClicks; i++) {
    const candidates = [
      page.getByRole('button', { name: /view more flights/i }),
      page.locator('button:has-text("View more flights")'),
      page.locator('button:has-text("more flights")'),
    ];
    let clicked = false;
    for (const btn of candidates) {
      try {
        const first = btn.first();
        if (await first.isVisible({ timeout: 1500 })) {
          await first.scrollIntoViewIfNeeded().catch(() => {});
          await first.click({ timeout: 3000 });
          clicks++;
          clicked = true;
          // Let the newly-revealed rows render before the next probe / the read.
          await randomDelay(1200, 2200);
          break;
        }
      } catch {
        // Try the next candidate selector.
      }
    }
    if (!clicked) break; // No expander left → list is fully expanded.
  }
  if (clicks > 0) {
    console.log(`[navigate] expanded flight list via ${clicks} 'View more' click(s)`);
  }
  return clicks;
}

export interface FlightSearchParams {
  origin: string;
  destination: string;
  dateFrom: Date;
  dateTo: Date;
  cabinClass?: string;
  tripType?: string; // 'one_way' | 'round_trip' | 'open_jaw' | 'multi_city'
  // Ordered legs for open-jaw / multi-city itineraries (ticket-tracker-k5m.5).
  // When present, THESE legs (each with its own from/to/date) describe the
  // itinerary — origin/destination/dateFrom/dateTo do not. Absent (undefined)
  // means a single-pair itinerary described by origin/destination + dates.
  segments?: Array<{ from: string; to: string; date: string }>;
  currency?: string | null; // ISO 4217 code. null = omit (Google auto-detects)
  country?: string | null; // ISO 3166-1 alpha-2. null = omit (Google auto-detects)
  // Optional passenger breakdown (design.md R1). Undefined fields default to
  // a single adult everywhere they are consumed, matching pre-R1 behavior.
  adults?: number;
  children?: number;
  infantsInSeat?: number;
  infantsOnLap?: number;
}

export type NavigationSource = 'google_flights' | 'airline_direct' | 'skyscanner' | 'kayak';

export const AGGREGATOR_SOURCES = ['google_flights', 'airline_direct', 'skyscanner', 'kayak'] as const;

export function isAggregatorSource(value: unknown): value is NavigationSource {
  return typeof value === 'string' && (AGGREGATOR_SOURCES as readonly string[]).includes(value);
}

export interface NavigationResult {
  html: string;
  url: string;
  resultsFound: boolean;
  source: NavigationSource;
  /**
   * True only when Google explicitly rendered its empty-results state for the
   * requested route ("No options matching your search"). Distinguishes a page
   * that ANSWERED the query with "nothing available" from one that never
   * answered at all (block, timeout, redirect) — both of which leave
   * resultsFound=false and are otherwise indistinguishable to callers.
   *
   * This is a market signal and callers may act on it, but per the
   * orchestrator's design it is NOT sufficient on its own to record
   * `no_options`: a soft-blocked browser can serve the same clean empty page.
   * The SSR canary still arbitrates no_options vs throttled.
   */
  noOptions?: boolean;
}

// IATA codes are exactly 3 uppercase A-Z. Anything else means the upstream
// query parser wrote garbage (or a user-supplied code escaped sanitization)
// and would otherwise corrupt the URL via raw interpolation.
const IATA_CODE = /^[A-Z]{3}$/;

export function assertValidIataCode(code: string, role: 'origin' | 'destination'): void {
  if (!IATA_CODE.test(code)) {
    throw new Error(`Invalid IATA ${role} code: ${JSON.stringify(code)}`);
  }
}

export function isoDate(d: Date): string {
  // toISOString().split('T')[0] returns the UTC calendar day. Callers that
  // construct dates in non-UTC timezones can see a day shift here; that risk
  // predates this file and is tracked separately.
  return d.toISOString().split('T')[0]!;
}

function buildFlightsUrl(qPhrase: string, params: FlightSearchParams): string {
  const url = new URL('https://www.google.com/travel/flights');
  url.searchParams.set('q', qPhrase);
  url.searchParams.set('hl', 'en');
  if (params.currency) url.searchParams.set('curr', params.currency);
  if (params.country) url.searchParams.set('gl', params.country);
  return url.toString();
}

export function buildGoogleFlightsUrl(params: FlightSearchParams): string {
  // Verbose phrase form. For one-way searches we omit the trailing "to ${dateTo}"
  // because Google Flights' NLU misparses "on YYYY-MM-DD to YYYY-MM-DD" for
  // less popular airport codes (BDS, BRI) and falls back to the bare homepage.
  // See #65.
  assertValidIataCode(params.origin, 'origin');
  assertValidIataCode(params.destination, 'destination');

  const dateFrom = isoDate(params.dateFrom);
  const dateTo = isoDate(params.dateTo);
  const oneWay = params.tripType === 'one_way';
  const oneWayPrefix = oneWay ? 'one way ' : '';
  const datePart = oneWay ? `on ${dateFrom}` : `on ${dateFrom} to ${dateTo}`;

  return buildFlightsUrl(
    `${oneWayPrefix}flights from ${params.origin} to ${params.destination} ${datePart}`,
    params,
  );
}

/**
 * Build three structurally distinct Google Flights URL candidates. The verbose
 * `q=` text URL is what humans land on, but it depends on Google's NLU and is
 * unreliable for less popular airport codes. Each candidate is a text URL that
 * carries the requested dates AND an unambiguous trip-type token — we
 * deliberately avoid date-less or trip-less URLs (SEO landings, partial
 * phrases) because Google fills missing fields with defaults and Playwright
 * would still see [data-gs], silently writing snapshots tagged with the
 * user's travelDate but priced for the wrong departure.
 */
export function buildGoogleFlightsUrlCandidates(params: FlightSearchParams): string[] {
  assertValidIataCode(params.origin, 'origin');
  assertValidIataCode(params.destination, 'destination');

  const dateFrom = isoDate(params.dateFrom);
  const dateTo = isoDate(params.dateTo);
  const oneWay = params.tripType === 'one_way';
  const oneWayPrefix = oneWay ? 'one way ' : '';

  // Variant 1: verbose phrase, fixed for one-way (above).
  const verbose = buildGoogleFlightsUrl(params);

  // Variant 2: terse codes + date — fewer NLU tokens for Google to misinterpret.
  // Always include the one-way token so Google does not infer round trip.
  const terseDate = oneWay ? dateFrom : `${dateFrom} to ${dateTo}`;
  const terse = buildFlightsUrl(
    `${oneWayPrefix}${params.origin} to ${params.destination} ${terseDate}`,
    params,
  );

  // Variant 3: reworded phrase — different verbs ("departing"/"returning") and
  // a different word order put the airport codes adjacent to the keywords
  // Google's NLU is most confident about, while still carrying the date(s)
  // and an explicit one-way marker for one-way trips.
  const dateClause = oneWay
    ? `departing ${dateFrom}`
    : `departing ${dateFrom} returning ${dateTo}`;
  const reworded = buildFlightsUrl(
    `${oneWayPrefix}flights to ${params.destination} from ${params.origin} ${dateClause}`,
    params,
  );

  return [verbose, terse, reworded];
}

/** Stable label per candidate index, used in logs so failures are diagnosable. */
const CANDIDATE_NAMES = ['verbose', 'terse', 'reworded'] as const;

/**
 * How long to wait for a Google Flights page to settle into EITHER a results
 * grid or an explicit empty-results verdict. See the race in
 * navigateGoogleFlightsUrl for why this is generous rather than tight.
 */
const VERDICT_TIMEOUT_MS = 75_000;

export async function navigateGoogleFlights(
  params: FlightSearchParams,
  countryProfile?: CountryProfile,
  proxyUrl?: string
): Promise<NavigationResult> {
  // Rotate URL formats per attempt — text URLs are unreliable for less-common
  // airport codes (#65), so retrying the same URL only ever hits the same
  // homepage redirect. Each attempt tries a structurally different URL.
  const urlCandidates = buildGoogleFlightsUrlCandidates(params);
  const maxAttempts = urlCandidates.length;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = urlCandidates[attempt - 1]!;
    const candidateName = CANDIDATE_NAMES[attempt - 1] ?? 'unknown';
    const browser = await launchBrowser({ proxyUrl });
    const attemptStart = Date.now();

    try {
      const context = await createStealthContext(browser, { countryProfile, proxyUrl });
      const page = await context.newPage();
      console.log(`[navigate] attempt ${attempt}/${maxAttempts} (${candidateName}) → ${url}`);

      const gotoStart = Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      console.log(`[navigate] goto resolved in ${Date.now() - gotoStart}ms`);

      // Wait for page to settle — randomized to look human
      await randomDelay(attempt === 1 ? 2000 : 4000, attempt === 1 ? 4000 : 7000);

      // Dismiss consent/cookie dialog — Google renders two identical "Accept all"
      // buttons; without .first() Playwright strict mode throws on the ambiguity
      try {
        const consentButton = page.locator('button:has-text("Accept all")').first();
        if (await consentButton.isVisible({ timeout: 2000 })) {
          await consentButton.click();
          await randomDelay(2000, 4000);
        }
      } catch {
        // No consent dialog — continue
      }

      // Wait for flight results — look for price elements
      let resultsFound = false;
      try {
        const selectorStart = Date.now();
        await page.waitForSelector('[data-gs]', { timeout: 15_000 });
        console.log(`[navigate] selector [data-gs] found in ${Date.now() - selectorStart}ms`);
        resultsFound = true;
      } catch {
        console.log(`[navigate] selector [data-gs] not found after 15s`);
      }

      // Simulate human behavior only after results load — reduces time
      // the page spends accumulating resources before we extract data
      if (resultsFound) {
        await simulateHumanBehavior(page);
        // Reveal the full carrier list (one-stops behind "View more flights")
        // before reading the DOM. (ticket-tracker-k5m.8)
        await expandRenderedFlights(page);
      }

      // Capture visible text instead of raw HTML — Google Flights pages are 2-3MB
      // of HTML but only ~3k of visible text, and flight data starts deep in the DOM
      // where a 50k char cap would never reach it
      const html = await page.evaluate(() => document.body.innerText);
      const finalUrl = page.url();

      // Belt-and-suspenders defense against silent route corruption. Three
      // layers; any failure marks the attempt failed and rotates to the next
      // URL candidate. A false success here would write snapshots labeled
      // with the user's travelDate but priced for a different route.
      //
      // 1. Homepage redirect: Google strips q= and lands on the bare
      //    /travel/flights URL. This is the headline #65 failure mode.
      // 2. Route membership + direction: both IATA codes must appear in the
      //    visible text AND in the requested order separated by a route
      //    connector (catches swapped routes and unrelated suggestion lists).
      if (resultsFound && pageRedirectedToHomepage(url, finalUrl)) {
        console.log(`[navigate] q= dropped on redirect (input=${url}, final=${finalUrl}) — treating attempt ${attempt} (${candidateName}) as failed`);
        resultsFound = false;
      }
      if (resultsFound && !pageHasRequestedRoute(html, params.origin, params.destination, params.currency)) {
        console.log(`[navigate] page text missing requested directional route (origin=${params.origin}, dest=${params.destination}, finalUrl=${finalUrl}) — treating attempt ${attempt} (${candidateName}) as failed`);
        resultsFound = false;
      }

      console.log(`[navigate] attempt ${attempt} (${candidateName}): resultsFound=${resultsFound}, textLength=${html.length}, finalUrl=${finalUrl}, elapsed=${Date.now() - attemptStart}ms`);

      await context.close();

      // Retry with fresh browser if no results and we have attempts left
      if (!resultsFound && attempt < maxAttempts) {
        console.log(`[navigate] no results on attempt ${attempt} (${candidateName}), retrying with next URL after delay…`);
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));
        continue;
      }

      if (resultsFound) {
        console.log(`[navigate] succeeded with ${candidateName} candidate (final URL: ${finalUrl})`);
      }
      return { html, url, resultsFound, source: 'google_flights' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isCrash = /crashed|target closed|disposed/i.test(message);
      console.error(`[navigate] attempt ${attempt} (${candidateName}) failed (crash=${isCrash}, elapsed=${Date.now() - attemptStart}ms): ${message}`);

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));
        continue;
      }
      throw error;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // Unreachable — loop always returns — but TypeScript needs it
  throw new Error('navigateGoogleFlights: exhausted all attempts');
}

/**
 * Single-attempt navigation to an exact, pre-built URL (the tfs protobuf URL
 * from the two-tier data plane — see apps/web/src/lib/dataplane/tfs-builder.ts).
 * No candidate rotation: unlike the NL-phrase URLs in navigateGoogleFlights,
 * a tfs URL is a canonical, unambiguous encoding of the query, so there is
 * no misparse risk to hedge against with alternate phrasings.
 *
 * Reuses navigateGoogleFlights's anti-corruption defenses (homepage-redirect
 * detection, directional-route text check) so a redirected/corrupted tfs
 * fetch fails the same way a corrupted NL fetch does, rather than silently
 * reporting no results as a false success. The redirect check is keyed on
 * the `tfs` query param (not `q`), since that's what this URL carries.
 */
export async function navigateGoogleFlightsUrl(
  url: string,
  params: FlightSearchParams,
  countryProfile?: CountryProfile,
  proxyUrl?: string,
): Promise<NavigationResult> {
  const browser = await launchBrowser({ proxyUrl });
  const attemptStart = Date.now();

  try {
    const context = await createStealthContext(browser, { countryProfile, proxyUrl });
    const page = await context.newPage();
    console.log(`[navigate] tfs attempt → ${url}`);

    const gotoStart = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    console.log(`[navigate] tfs goto resolved in ${Date.now() - gotoStart}ms`);

    await randomDelay(2000, 4000);

    try {
      const consentButton = page.locator('button:has-text("Accept all")').first();
      if (await consentButton.isVisible({ timeout: 2000 })) {
        await consentButton.click();
        await randomDelay(2000, 4000);
      }
    } catch {
      // No consent dialog — continue
    }

    // Race the two states Google can settle into, rather than polling only for
    // [data-gs] and calling everything else a failure. Google's genuine
    // "No options matching your search" page has no [data-gs] either, so a
    // selector-only wait cannot tell "the market has nothing" apart from "we
    // never got an answer" — and the caller then reports a query it DID check
    // as one it declined to check.
    //
    // The ceiling is generous because the two states do NOT settle on the same
    // timescale. A results grid renders within a few seconds, but the
    // empty-results state waits on Google's GetShoppingResults RPC, which it
    // slow-walks under load: measured 2026-07-11 at 5-10s when fresh and 58s
    // when the IP had been making frequent requests, returning the identical
    // 16KB "no options" payload both times. A tight ceiling therefore
    // systematically misreads sold-out cells as failures precisely when the
    // scrape is busiest. This costs nothing on the happy path — the race
    // resolves the moment EITHER state appears, so a page with results still
    // returns in seconds; only a genuinely unsettled page waits out the clock.
    const verdict = await page
      .waitForFunction(
        (phrases: readonly string[]) => {
          if (document.querySelector('[data-gs]')) return 'results';
          const text = document.body?.innerText ?? '';
          if (phrases.some((p) => text.includes(p))) return 'no_options';
          return null; // neither state yet — keep polling
        },
        NO_OPTIONS_PHRASES,
        { timeout: VERDICT_TIMEOUT_MS },
      )
      .then((handle) => handle.jsonValue() as Promise<'results' | 'no_options'>)
      .catch(() => null);

    if (verdict === null) {
      console.log(
        `[navigate] tfs: page settled into neither results nor an empty-results verdict ` +
          `within ${VERDICT_TIMEOUT_MS}ms — no market signal, caller must not infer no_options`,
      );
    }

    let resultsFound = verdict === 'results';

    if (resultsFound) {
      await simulateHumanBehavior(page);
      // Reveal the full carrier list (one-stops behind "View more flights")
      // before reading the DOM. (ticket-tracker-k5m.8)
      await expandRenderedFlights(page);
    }

    const html = await page.evaluate(() => document.body.innerText);
    const finalUrl = page.url();

    // Re-verify the empty-results verdict against the settled page text, which
    // also confirms the search UI rendered the airports we asked for. A block
    // or interstitial page cannot satisfy both conditions.
    const noOptions =
      verdict === 'no_options' &&
      !pageRedirectedToHomepage(url, finalUrl, 'tfs') &&
      pageShowsNoOptions(html, params.origin, params.destination);

    if (noOptions) {
      console.log(
        `[navigate] tfs: Google rendered no-options for ${params.origin}->${params.destination} ` +
          `— a market answer, not a navigation failure`,
      );
    }

    if (resultsFound && pageRedirectedToHomepage(url, finalUrl, 'tfs')) {
      console.log(`[navigate] tfs param dropped on redirect (input=${url}, final=${finalUrl}) — treating as failed`);
      resultsFound = false;
    }
    if (resultsFound && !pageHasRequestedRoute(html, params.origin, params.destination, params.currency)) {
      console.log(`[navigate] tfs page text missing requested directional route (origin=${params.origin}, dest=${params.destination}, finalUrl=${finalUrl}) — treating as failed`);
      resultsFound = false;
    }

    console.log(`[navigate] tfs: resultsFound=${resultsFound}, noOptions=${noOptions}, textLength=${html.length}, finalUrl=${finalUrl}, elapsed=${Date.now() - attemptStart}ms`);

    await context.close();
    return { html, url, resultsFound, noOptions, source: 'google_flights' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[navigate] tfs attempt failed (elapsed=${Date.now() - attemptStart}ms): ${message}`);
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

export interface FlightDetailResult {
  airlineDirectPrice: number | null;
  airlineDirectCurrency: string | null;
  bookingUrl: string | null;
  allBookingOptions: Array<{
    provider: string;
    isAirline: boolean;
    price: number;
    currency: string;
  }>;
}

export async function navigateFlightDetail(
  params: FlightSearchParams,
  flightIndex: number,
  countryProfile?: CountryProfile,
  proxyUrl?: string
): Promise<FlightDetailResult> {
  const browser = await launchBrowser({ proxyUrl });
  const start = Date.now();

  try {
    const context = await createStealthContext(browser, { countryProfile, proxyUrl });
    const page = await context.newPage();

    // Must use one-way search so clicking goes directly to booking options
    const url = buildGoogleFlightsUrl({ ...params, tripType: 'one_way' });
    console.log(`[navigate:detail] → ${url}`);

    const gotoStart = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    console.log(`[navigate:detail] goto resolved in ${Date.now() - gotoStart}ms`);

    await randomDelay(2000, 4000);

    // Dismiss consent
    try {
      const consentButton = page.locator('button:has-text("Accept all")').first();
      if (await consentButton.isVisible({ timeout: 2000 })) {
        await consentButton.click();
        await randomDelay(2000, 4000);
      }
    } catch {
      // No consent dialog
    }

    // Wait for results
    try {
      const selectorStart = Date.now();
      await page.waitForSelector('li.pIav2d', { timeout: 15_000 });
      console.log(`[navigate:detail] selector li.pIav2d found in ${Date.now() - selectorStart}ms`);
    } catch {
      console.log(`[navigate:detail] selector li.pIav2d not found after 15s, elapsed=${Date.now() - start}ms`);
      await context.close();
      return { airlineDirectPrice: null, airlineDirectCurrency: null, bookingUrl: null, allBookingOptions: [] };
    }

    // Click the specific flight result
    const flightItems = page.locator('li.pIav2d');
    const count = await flightItems.count();
    if (flightIndex >= count) {
      await context.close();
      return { airlineDirectPrice: null, airlineDirectCurrency: null, bookingUrl: null, allBookingOptions: [] };
    }

    await flightItems.nth(flightIndex).click();
    await page.waitForTimeout(4000);

    // Extract booking options from the detail view
    // Google Flights renders "Book with LOTAirline\n$662" (Airline appended to name)
    // or "Book with Mytrip\n$704" (no Airline tag for OTAs)
    const detailCurrency = params.currency || null;
    const result = await page.evaluate((curr) => {
      const text = document.body.innerText ?? '';
      const options: Array<{ provider: string; isAirline: boolean; price: number; currency: string }> = [];

      const bookingPattern = /Book with (.+?)(?:Airline)?\n[£€$¥]?\s?([\d,.]+)/g;
      let match;
      while ((match = bookingPattern.exec(text)) !== null) {
        const rawProvider = match[1]!.trim();
        // Check if the full match area contains "Airline" tag
        const fullMatch = match[0]!;
        const isAirline = /Airline/.test(fullMatch);
        const provider = rawProvider.replace(/Airline$/, '').trim();
        const price = parseInt(match[2]!.replace(/[,.]/g, ''), 10);
        if (!isNaN(price) && provider.length > 0) {
          options.push({ provider, isAirline, price, currency: curr || 'USD' });
        }
      }

      return options;
    }, detailCurrency);

    await context.close();

    // Find the airline-direct option (tagged as "Airline")
    const airlineOption = result.find((o) => o.isAirline);
    console.log(`[navigate:detail] done: ${result.length} booking options, elapsed=${Date.now() - start}ms`);

    return {
      airlineDirectPrice: airlineOption?.price ?? null,
      airlineDirectCurrency: airlineOption?.currency ?? null,
      bookingUrl: null, // booking URL requires following a redirect — use Google Flights link
      allBookingOptions: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[navigate:detail] failed (elapsed=${Date.now() - start}ms): ${message}`);
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function navigateAirlineDirect(
  params: FlightSearchParams,
  airlineName: string,
  countryProfile?: CountryProfile,
  proxyUrl?: string
): Promise<NavigationResult> {
  const url = getAirlineUrl(airlineName, params);
  if (!url) {
    throw new Error(`No URL pattern for airline: ${airlineName}`);
  }

  const browser = await launchBrowser({ proxyUrl });
  const start = Date.now();

  try {
    const context = await createStealthContext(browser, { countryProfile, proxyUrl });
    const page = await context.newPage();
    console.log(`[navigate:airline] → ${url}`);

    const gotoStart = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    console.log(`[navigate:airline] goto resolved in ${Date.now() - gotoStart}ms`);

    // Airline sites are slower — wait for dynamic content to render
    await randomDelay(4000, 7000);
    await simulateHumanBehavior(page);

    // Dismiss cookie/consent dialogs common on airline sites
    try {
      for (const label of ['Accept all', 'Accept', 'I agree', 'Accept cookies', 'OK', 'Got it']) {
        const btn = page.locator(`button:has-text("${label}")`).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          await randomDelay(1500, 3000);
          break;
        }
      }
    } catch {
      // No consent dialog — continue
    }

    // Two-criterion price signal (see hasFlightPriceSignal at module top, issue 65).
    let resultsFound = false;
    try {
      await page.waitForFunction(
        (params: { mention: string; token: string; min: number }) => {
          const text = document.body?.innerText ?? '';
          const mentions = (text.match(new RegExp(params.mention, 'g')) || []).length;
          if (mentions < params.min) return false;
          return new RegExp(params.token).test(text);
        },
        { mention: CURRENCY_MENTION_PATTERN, token: PRICE_TOKEN_PATTERN, min: MIN_CURRENCY_MENTIONS },
        { timeout: 15_000 }
      );
      resultsFound = true;
    } catch {
      // No price signal detected — page may be a stub, marketing redirect, or block.
    }

    const html = await page.evaluate(() => document.body.innerText);
    console.log(`[navigate:airline] resultsFound=${resultsFound}, textLength=${html.length}, elapsed=${Date.now() - start}ms`);

    await context.close();
    return { html, url, resultsFound, source: 'airline_direct' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[navigate:airline] failed (elapsed=${Date.now() - start}ms): ${message}`);
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Skyscanner uses lowercase 3-letter IATA codes in the path. The site accepts
// uppercase via redirect, but the canonical form is lowercase.
function isoDateShort(d: Date): string {
  const iso = isoDate(d); // YYYY-MM-DD
  return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10); // YYMMDD
}

// Skyscanner cabin slugs — mapping is the same set our app uses elsewhere.
const SKYSCANNER_CABIN: Record<string, string> = {
  economy: 'economy',
  premium_economy: 'premiumeconomy',
  business: 'business',
  first: 'first',
};

export function buildSkyscannerUrl(params: FlightSearchParams): string {
  assertValidIataCode(params.origin, 'origin');
  assertValidIataCode(params.destination, 'destination');

  const ori = params.origin.toLowerCase();
  const dst = params.destination.toLowerCase();
  const oneWay = params.tripType === 'one_way';
  const datePath = oneWay
    ? `${isoDateShort(params.dateFrom)}/`
    : `${isoDateShort(params.dateFrom)}/${isoDateShort(params.dateTo)}/`;

  const cabin = SKYSCANNER_CABIN[params.cabinClass ?? 'economy'] ?? 'economy';
  const qs = new URLSearchParams();
  qs.set('adultsv2', '1');
  qs.set('cabinclass', cabin);
  if (params.currency) qs.set('currency', params.currency);
  if (params.country) qs.set('market', params.country);

  return `https://www.skyscanner.com/transport/flights/${ori}/${dst}/${datePath}?${qs.toString()}`;
}

export function buildKayakUrl(params: FlightSearchParams): string {
  assertValidIataCode(params.origin, 'origin');
  assertValidIataCode(params.destination, 'destination');

  const ori = params.origin;
  const dst = params.destination;
  const oneWay = params.tripType === 'one_way';
  const datePath = oneWay
    ? isoDate(params.dateFrom)
    : `${isoDate(params.dateFrom)}/${isoDate(params.dateTo)}`;

  return `https://www.kayak.com/flights/${ori}-${dst}/${datePath}?sort=price_a`;
}

/**
 * Shared navigation helper for Skyscanner and Kayak. Both deploy aggressive
 * anti-bot (Cloudflare, PerimeterX) so reliability is best-effort, not
 * production grade. The 45s goto timeout matches navigateAirlineDirect because
 * Cloudflare interstitials regularly take 20-40s to clear.
 *
 * Caller passes a stable `source` label and a `tag` for log lines. Returns the
 * standard NavigationResult; resultsFound is gated by hasFlightPriceSignal so a
 * blocked or interstitial page returns resultsFound=false and the caller can
 * walk to the next aggregator in the chain.
 */
async function navigateAggregatorPage(
  url: string,
  source: NavigationSource,
  tag: string,
  countryProfile?: CountryProfile,
  proxyUrl?: string,
): Promise<NavigationResult> {
  const browser = await launchBrowser({ proxyUrl });
  const start = Date.now();

  try {
    const context = await createStealthContext(browser, { countryProfile, proxyUrl });
    const page = await context.newPage();
    console.log(`[navigate:${tag}] → ${url}`);

    const gotoStart = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    console.log(`[navigate:${tag}] goto resolved in ${Date.now() - gotoStart}ms`);

    // Heavier post-goto wait than airline_direct — Cloudflare interstitials on
    // Skyscanner and Kayak commonly delay real content by 4-8 seconds.
    await randomDelay(4000, 8000);
    await simulateHumanBehavior(page);

    try {
      for (const label of ['Accept all', 'I agree', 'OK, got it', 'Got it', 'Allow all', 'Accept cookies']) {
        const btn = page.locator(`button:has-text("${label}")`).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          await randomDelay(1500, 3000);
          break;
        }
      }
    } catch {
      // No consent dialog visible.
    }

    let resultsFound = false;
    try {
      await page.waitForFunction(
        (p: { mention: string; token: string; min: number }) => {
          const text = document.body?.innerText ?? '';
          const mentions = (text.match(new RegExp(p.mention, 'g')) || []).length;
          if (mentions < p.min) return false;
          return new RegExp(p.token).test(text);
        },
        { mention: CURRENCY_MENTION_PATTERN, token: PRICE_TOKEN_PATTERN, min: MIN_CURRENCY_MENTIONS },
        { timeout: 15_000 },
      );
      resultsFound = true;
    } catch {
      // No price signal — most likely Cloudflare challenge, PerimeterX, or empty results.
    }

    const html = await page.evaluate(() => document.body.innerText);
    console.log(`[navigate:${tag}] resultsFound=${resultsFound}, textLength=${html.length}, elapsed=${Date.now() - start}ms`);

    await context.close();
    return { html, url, resultsFound, source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[navigate:${tag}] failed (elapsed=${Date.now() - start}ms): ${message}`);
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function navigateSkyscanner(
  params: FlightSearchParams,
  countryProfile?: CountryProfile,
  proxyUrl?: string,
): Promise<NavigationResult> {
  const url = buildSkyscannerUrl(params);
  return navigateAggregatorPage(url, 'skyscanner', 'skyscanner', countryProfile, proxyUrl);
}

export async function navigateKayak(
  params: FlightSearchParams,
  countryProfile?: CountryProfile,
  proxyUrl?: string,
): Promise<NavigationResult> {
  const url = buildKayakUrl(params);
  return navigateAggregatorPage(url, 'kayak', 'kayak', countryProfile, proxyUrl);
}
