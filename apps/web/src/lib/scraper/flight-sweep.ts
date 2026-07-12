/**
 * Deterministic Google Flights sweeper.
 *
 * Every itinerary on a results page is a `div[role="link"]` whose `aria-label`
 * is a fully structured sentence, e.g.
 *
 *   "From 2233 US dollars round trip total. 1 stop flight with Qantas. Leaves
 *    Los Angeles International Airport at 10:40 PM on Thursday, December 10 and
 *    arrives at Auckland Airport at 5:20 AM on Sunday, December 13. Total
 *    duration 23 hr 40 min. Layover (1 of 1) is a 3 hr 30 min layover at
 *    Melbourne Airport in Melbourne. Select flight"
 *
 * We parse that string and take the minimum in code. No LLM: an itinerary price
 * that a model "recalled" is a fabrication risk, and this project has already
 * shipped four confident wrong numbers.
 *
 * Two hard invariants, both of which throw rather than return a suspect number:
 *
 *  1. PARTY ASSERTION. The page prints "Prices include required taxes + fees for
 *     N passengers". N must equal the party we requested. A 1-adult fare has
 *     twice been reported as a 5-person family total; this assertion is the fix.
 *
 *  2. TOTAL-vs-PER-SEAT CALIBRATION. Google prices scale with party size
 *     (1 adult $745 / 2 adults $1,489 / 3 adults $2,233), i.e. the number on the
 *     card is the TOTAL FOR THE PARTY, so per-seat = total / N. That is an
 *     empirical claim about Google's UI, not a law, so `calibrate()` re-proves it
 *     live before a sweep is allowed to report per-seat figures.
 *
 * A third invariant lives in the caller (see `monotonicityCheck`): seat
 * availability cannot GROW as a party gets larger, so a "no options" at 3 adults
 * on a route/date where 1 adult is priced is provably fabricated, not sold out.
 */
import type { Browser, Page } from 'playwright';
import { buildTfsUrl, type TfsQuery } from '../dataplane/tfs-builder';

/** Google fabricates an empty result page for parties >= 4. Never exceed this. */
export const MAX_SAFE_PARTY = 3;

export interface Itinerary {
  /** Price exactly as printed: the TOTAL for the whole requested party. */
  totalPrice: number;
  currency: string;
  /** totalPrice / party, rounded. Only meaningful once calibration passes. */
  perSeat: number;
  airlines: string[];
  stops: number;
  layovers: string[];
  durationMinutes: number | null;
  raw: string;
}

export type CellStatus = 'priced' | 'no-options' | 'blocked' | 'error';

export interface CellResult {
  label: string;
  url: string;
  party: number;
  status: CellStatus;
  itineraries: Itinerary[];
  cheapest: Itinerary | null;
  /** Passenger count Google echoed back, parsed from the taxes+fees line. */
  observedParty: number | null;
  note?: string;
}

const PRICE_RE = /^From\s+([\d,]+)\s+(US dollars|dollars|euros|pounds|New Zealand dollars)/i;
const STOPS_RE = /\b(\d+)\s+stops?\s+flight\b/i;
const NONSTOP_RE = /\bNonstop flight\b/i;
const AIRLINE_RE = /(?:Nonstop|\d+\s+stops?)\s+flight\s+with\s+(.+?)\.\s/i;
const DURATION_RE = /Total duration\s+(?:(\d+)\s*hr)?\s*(?:(\d+)\s*min)?/i;
const LAYOVER_RE = /layover at ([^.]+?) in ([A-Za-z .'-]+?)\./gi;
const PARTY_RE = /Prices include required taxes \+ fees for (\d+) (?:passengers?|adults?)/i;

const CURRENCY_CODES: Record<string, string> = {
  'us dollars': 'USD',
  dollars: 'USD',
  euros: 'EUR',
  pounds: 'GBP',
  'new zealand dollars': 'NZD',
};

/**
 * Parse one itinerary aria-label. Returns null for any `role="link"` that is not
 * an itinerary card (Google uses the role for nav chrome too), so callers can
 * simply filter nulls rather than pre-selecting by fragile CSS.
 */
export function parseItinerary(label: string, party: number): Itinerary | null {
  const priceMatch = PRICE_RE.exec(label.trim());
  if (!priceMatch) return null;

  const totalPrice = Number(priceMatch[1]!.replace(/,/g, ''));
  if (!Number.isFinite(totalPrice) || totalPrice <= 0) return null;

  const currency = CURRENCY_CODES[priceMatch[2]!.toLowerCase()] ?? priceMatch[2]!;

  let stops: number;
  if (NONSTOP_RE.test(label)) stops = 0;
  else {
    const s = STOPS_RE.exec(label);
    if (!s) return null; // Neither nonstop nor "N stop(s)" -> not an itinerary card.
    stops = Number(s[1]);
  }

  const airlineMatch = AIRLINE_RE.exec(label);
  const airlines = airlineMatch
    ? airlineMatch[1]!
        .split(/,\s*|\s+and\s+/)
        .map((a) => a.trim())
        .filter(Boolean)
    : [];

  const d = DURATION_RE.exec(label);
  const durationMinutes = d && (d[1] || d[2]) ? Number(d[1] ?? 0) * 60 + Number(d[2] ?? 0) : null;

  const layovers: string[] = [];
  for (const m of label.matchAll(LAYOVER_RE)) layovers.push(m[2]!.trim());

  return {
    totalPrice,
    currency,
    perSeat: Math.round(totalPrice / party),
    airlines,
    stops,
    layovers,
    durationMinutes,
    raw: label.trim(),
  };
}

/** Passenger count Google echoes back on the results page, or null if absent. */
export function parseObservedParty(pageText: string): number | null {
  const m = PARTY_RE.exec(pageText);
  return m ? Number(m[1]) : null;
}

export function looksBlocked(pageText: string): boolean {
  return (
    /unusual traffic|not a robot|recaptcha|solve the puzzle/i.test(pageText) &&
    !/Prices include required taxes/i.test(pageText)
  );
}

export function looksEmpty(pageText: string): boolean {
  return /No options matching your search|no flights found|try different dates/i.test(pageText);
}

/**
 * A 3-adult "no options" is only believable if 1 adult is ALSO empty on the same
 * route and dates. Seat inventory cannot grow with party size, so a priced
 * 1-adult page next to an empty 3-adult page proves the 3-adult page is fake.
 */
export function monotonicityCheck(
  threePax: CellResult,
  onePax: CellResult,
): { genuine: boolean; reason: string } {
  if (threePax.status !== 'no-options') {
    return { genuine: false, reason: 'not a no-options cell' };
  }
  if (onePax.status === 'priced') {
    return {
      genuine: false,
      reason: `FABRICATED: 1 adult shows ${onePax.itineraries.length} priced itineraries (from $${onePax.cheapest?.totalPrice}) on the same route/dates. Availability cannot grow with party size.`,
    };
  }
  if (onePax.status === 'no-options') {
    return { genuine: true, reason: '1-adult control is also empty; sold-out is credible' };
  }
  return { genuine: false, reason: `1-adult control inconclusive (${onePax.status})` };
}

async function dismissConsent(page: Page): Promise<void> {
  for (const sel of [
    'button:has-text("Accept all")',
    'button:has-text("Reject all")',
    'button[aria-label*="Accept"]',
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
  }
}

export interface SearchOptions {
  timeoutMs?: number;
  /** Retries on a soft `error` (un-hydrated results shell). Default 1. */
  retries?: number;
}

/**
 * Load one search URL and deterministically extract every itinerary on it,
 * retrying a soft failure once.
 *
 * Google intermittently serves a shell page that never hydrates its results
 * (~30% of loads under sustained sweeping). That is indistinguishable at the DOM
 * level from a genuine empty, so it is reported as `error`, NEVER as
 * `no-options` — silently collapsing a slow load into "sold out" is precisely
 * how this project accumulated its retracted findings.
 */
export async function searchCell(
  browser: Browser,
  label: string,
  query: TfsQuery,
  opts: SearchOptions = {},
): Promise<CellResult> {
  const attempts = opts.retries ?? 1;
  let last = await searchCellOnce(browser, label, query, opts);
  for (let i = 0; i < attempts && last.status === 'error'; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    last = await searchCellOnce(browser, label, query, opts);
  }
  return last;
}

async function searchCellOnce(
  browser: Browser,
  label: string,
  query: TfsQuery,
  opts: SearchOptions = {},
): Promise<CellResult> {
  const party =
    (query.passengers.adults ?? 0) +
    (query.passengers.children ?? 0) +
    (query.passengers.infantsInSeat ?? 0) +
    (query.passengers.infantsOnLap ?? 0);

  if (party > MAX_SAFE_PARTY) {
    throw new Error(
      `Refusing to search a party of ${party}. Google fabricates an empty result page ` +
        `for parties >= 4; any answer it gives would be untrustworthy. Search at <= ${MAX_SAFE_PARTY}.`,
    );
  }

  const url = buildTfsUrl(query);
  const base: Omit<CellResult, 'status'> = {
    label,
    url,
    party,
    itineraries: [],
    cheapest: null,
    observedParty: null,
  };

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 45_000 });
    await dismissConsent(page);

    // Results stream in after hydration; wait for either an itinerary card or
    // the empty-state copy rather than a blind sleep.
    await Promise.race([
      page.waitForSelector('div[role="link"][aria-label^="From"]', { timeout: 30_000 }),
      page.waitForFunction(
        () => /No options matching your search/i.test(document.body.innerText),
        { timeout: 30_000 },
      ),
    ]).catch(() => {});
    await page.waitForTimeout(1_500);

    const pageText = await page.evaluate(() => document.body.innerText);

    if (looksBlocked(pageText)) {
      return { ...base, status: 'blocked', note: 'CAPTCHA / unusual-traffic interstitial' };
    }

    const observedParty = parseObservedParty(pageText);
    const labels = await page.$$eval('div[role="link"]', (nodes) =>
      nodes.map((n) => n.getAttribute('aria-label') ?? ''),
    );
    const itineraries = labels
      .map((l) => parseItinerary(l, party))
      .filter((i): i is Itinerary => i !== null);

    if (itineraries.length === 0) {
      return {
        ...base,
        observedParty,
        status: looksEmpty(pageText) ? 'no-options' : 'error',
        note: looksEmpty(pageText) ? 'Google reports no options' : 'no cards and no empty-state copy',
      };
    }

    // THE GUARD. If Google did not echo back the party we asked for, the prices
    // on this page are for some other party and must never be reported.
    if (observedParty === null) {
      return {
        ...base,
        observedParty,
        status: 'error',
        note: 'could not confirm party size on page; refusing to report prices',
      };
    }
    if (observedParty !== party) {
      return {
        ...base,
        observedParty,
        status: 'error',
        note: `PARTY MISMATCH: requested ${party}, page priced ${observedParty}. Prices discarded.`,
      };
    }

    const cheapest = itineraries.reduce((a, b) => (b.totalPrice < a.totalPrice ? b : a));
    return { ...base, observedParty, status: 'priced', itineraries, cheapest };
  } catch (err) {
    return { ...base, status: 'error', note: err instanceof Error ? err.message : String(err) };
  } finally {
    await context.close().catch(() => {});
  }
}

export function roundTrip(
  from: string,
  to: string,
  depart: string,
  ret: string,
  adults: number,
): TfsQuery {
  return {
    trip: 'round-trip',
    seat: 'economy',
    segments: [
      { date: depart, fromAirport: from, toAirport: to },
      { date: ret, fromAirport: to, toAirport: from },
    ],
    passengers: { adults },
  };
}

export function openJaw(
  from: string,
  into: string,
  homeFrom: string,
  depart: string,
  ret: string,
  adults: number,
): TfsQuery {
  return {
    trip: 'open-jaw',
    seat: 'economy',
    segments: [
      { date: depart, fromAirport: from, toAirport: into },
      { date: ret, fromAirport: homeFrom, toAirport: from },
    ],
    passengers: { adults },
  };
}

/** LAX -> stopover city (stay N days) -> AKL -> LAX. */
export function stopover(
  home: string,
  via: string,
  dest: string,
  departHome: string,
  departVia: string,
  ret: string,
  adults: number,
): TfsQuery {
  return {
    trip: 'multi-city',
    seat: 'economy',
    segments: [
      { date: departHome, fromAirport: home, toAirport: via },
      { date: departVia, fromAirport: via, toAirport: dest },
      { date: ret, fromAirport: dest, toAirport: home },
    ],
    passengers: { adults },
  };
}
