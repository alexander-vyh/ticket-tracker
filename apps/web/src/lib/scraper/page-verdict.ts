/**
 * Verdict helpers: given the text/URL of a page we just loaded, decide WHAT THE
 * PAGE IS TELLING US. Extracted from navigate.ts (which drives the browser) so
 * the "what did we get back" judgement is testable without a browser and so
 * navigate.ts stays under the complexity gate.
 *
 * The distinction this module exists to protect: a page that carries a market
 * signal ("Google looked and there are no options") versus a page that carries
 * none (block, interstitial, timeout, misparsed route). Confusing the two in
 * either direction corrupts the availability history.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Issue 65: navigateAirlineDirect previously used a loose regex that accepted
// any single currency symbol plus digit. A Turkish stub page (1964 chars,
// "EUR" appearing in marketing copy) passed the gate, then extraction returned
// zero prices and the cron silently saved nothing every cycle. Two-criterion
// signal:
//   1. Currency must be mentioned at least MIN_CURRENCY_MENTIONS times. Real
//      airline result pages render many flight rows each with a price;
//      marketing stubs typically mention currency 0 to 2 times in chrome.
//   2. At least one price-shaped token (symbol or bounded code adjacent to a
//      digit). Lookaround prevents matching "TRY" inside INDUSTRY or "EUR"
//      inside EURO trip.
export const CURRENCY_MENTION_PATTERN = '€|£|\\$|EUR|GBP|USD|TRY|JPY|CHF';
export const PRICE_TOKEN_PATTERN = '(?:€|£|\\$)\\s?\\d|(?<![A-Za-z])(?:EUR|GBP|USD|TRY|JPY|CHF)(?![A-Za-z])\\s?\\d';
export const MIN_CURRENCY_MENTIONS = 3;

export function hasFlightPriceSignal(text: string): boolean {
  const mentions = (text.match(new RegExp(CURRENCY_MENTION_PATTERN, 'g')) || []).length;
  if (mentions < MIN_CURRENCY_MENTIONS) return false;
  return new RegExp(PRICE_TOKEN_PATTERN).test(text);
}

/**
 * The phrases Google Flights renders in its empty-results state, in the exact
 * form they appear in `document.body.innerText`. Kept as source strings (not
 * RegExp objects) because they are also evaluated inside the page context by
 * navigate.ts's waitForFunction, which can only receive serializable args.
 *
 * Verified 2026-07-11 against LAX->AKL 2026-12-08/2026-12-31 for 3 adults +
 * 2 children, in BOTH the container's headless Chromium and a real desktop
 * Chrome on a residential IP — both render:
 *
 *   "No results returned.
 *    No options matching your search
 *    Try changing your dates or destination to see results"
 */
export const NO_OPTIONS_PHRASES = [
  'No options matching your search',
  'No results returned',
  'No flights found',
] as const;

/**
 * Did Google explicitly tell us this itinerary has no bookable options?
 *
 * This is a MARKET SIGNAL, and the whole point of separating it from a plain
 * navigation failure: a query that Google answered with "no options" was
 * genuinely checked, whereas a query whose page never rendered was not. The
 * former may legitimately become `no_options`; the latter never may.
 *
 * Precision guard: the phrase alone is NOT enough. A block page, an error
 * interstitial, or a stray suggestion list could carry similar words. We also
 * require that the Flights search UI actually rendered the requested airports —
 * Google's empty-results page still shows the populated search header
 * ("Los Angeles LAX ... Auckland AKL"). A challenge/consent page does not.
 *
 * NOTE this is deliberately NOT the last word. Per the orchestrator's design,
 * a soft-blocked browser can serve a clean "No results" page that is
 * indistinguishable from genuine no-availability, so the final no_options vs
 * throttled call still belongs to the SSR canary. This function only certifies
 * "we got an answer, not a failure" — enough to stop the caller from claiming
 * it never looked.
 */
export function pageShowsNoOptions(pageText: string, origin: string, destination: string): boolean {
  const saidNoOptions = NO_OPTIONS_PHRASES.some((p) =>
    new RegExp(escapeRegex(p), 'i').test(pageText),
  );
  if (!saidNoOptions) return false;

  const mentionsOrigin = new RegExp(`\\b${escapeRegex(origin)}\\b`).test(pageText);
  const mentionsDestination = new RegExp(`\\b${escapeRegex(destination)}\\b`).test(pageText);
  return mentionsOrigin && mentionsDestination;
}

/**
 * Currencies allowed inside the route-validation gap. The first 21 entries
 * mirror the dropdown in apps/web/src/app/settings/page.tsx; TRY is added
 * because Flight Finder's #64 example was IST/AYT (Turkish market) and TRY
 * labels appear in those headers even though TRY is not in the settings
 * dropdown today.
 *
 * Accepted residual risk: several of these codes are also valid IATA
 * airport codes (HKD = Hakodate, BRL = Borba, CAD = Cadillac, CHF = Chefornak,
 * NOK = Nogales, DKK = Dakar military, ARS = Aragarcas, etc.). A chained
 * route like "BDS to HKD via JFK" therefore accepts under current policy.
 * Real Google Flights pages do not render that phrasing for a JFK booking,
 * so the practical corruption frequency is near zero, but the invariant is
 * not "currencies are never airport codes". Removing overlapping codes
 * would re-introduce false negatives for users in those currency locales,
 * which is the actual reported bug; on balance we keep them.
 *
 * Users selecting "Other..." in settings pass the custom code via the
 * `currency` arg to pageHasRequestedRoute, allowed dynamically.
 */
export const ALLOWED_CURRENCY_TOKENS = [
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'MXN',
  'BRL', 'KRW', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'NZD', 'THB', 'COP',
  'ARS', 'TRY',
] as const;

/**
 * Verify the loaded Google Flights page shows the requested route IN THE
 * REQUESTED DIRECTION via at least one strict pattern. Loose membership +
 * proximity checks were rejected by audit because:
 *
 * * Chained routes leak: "BDS Brindisi to LHR via JFK" matched
 *   `BDS ... to ... JFK` even though the requested route never appears.
 * * Plain "to" is not token-bounded: matches inside "stop", "Toronto",
 *   "destination", so any flight card with a stop satisfies the regex
 *   regardless of the actual airports.
 * * Plain dash characters appear in dates, durations, and price ranges,
 *   so a wide context window around any dash gives false positives.
 *
 * Strict patterns demand immediate adjacency between the airport codes and
 * a route connector. That is what Google actually renders on results
 * pages: the search-bar header, breadcrumbs, and route chips all show
 * `from BDS to JFK`, `BDS - John F. Kennedy`, or `BDS → JFK` with the
 * codes adjacent to the connector.
 *
 * Failure modes this function does NOT cover:
 *
 * * Wrong date with the right route. Google renders dates in too many
 *   formats to match reliably; mitigated by carrying the date in every
 *   URL candidate and by URL rotation.
 * * Wrong trip type. Mitigated by the explicit `one way` token in every
 *   one-way URL candidate.
 *
 * Both residual risks fail-soft (the next candidate retries) rather than
 * silently overwriting good snapshots.
 *
 * This check is for RESULTS pages. Google's empty-results page renders the
 * airports in a header without a route connector, so it does NOT satisfy this
 * predicate — that is why pageShowsNoOptions does its own, looser airport
 * check rather than reusing this one.
 */
export function pageHasRequestedRoute(
  pageText: string,
  origin: string,
  destination: string,
  currency?: string | null,
): boolean {
  const o = escapeRegex(origin);
  const d = escapeRegex(destination);

  // Tokens the strict regex allows inside the gap between origin and destination:
  //
  // 1. Origin and destination themselves: Google headers render the code both
  //    as a label and a parenthetical alias ("BDS Brindisi (BDS) to JFK").
  // 2. The currency the query uses: passed dynamically so users who selected
  //    "Other..." in settings (any ISO 4217 3-letter code) are covered.
  // 3. The standard supported currency list (above): covers cases where the
  //    query has currency=null and Google auto-detects locale-appropriate.
  //
  // Two things block the gap:
  //
  // (a) Any 3-letter uppercase token NOT in the allowlist (LHR, FCO, NYC,
  //     USA) blocks. That stops "BDS Brindisi to LHR via JFK" from matching.
  // (b) The chaining keywords `via`, `layover`, `through`, `connecting`
  //     block. That closes the currency/IATA overlap edge case (HKD is
  //     also Hakodate airport): "BDS to HKD via JFK" still has `via` in
  //     the gap, so the lazy match cannot reach JFK regardless of whether
  //     HKD is treated as currency or airport. Real Google Flights route
  //     headers never use these words between the airport pair.
  const dynamicCurrency = currency && /^[A-Z]{3}$/.test(currency) ? [currency] : [];
  const allowedInGap = [origin, destination, ...dynamicCurrency, ...ALLOWED_CURRENCY_TOKENS]
    .map(escapeRegex)
    .join('|');
  // Chaining keywords matched case-insensitively. JS regex has no inline (?i)
  // flag and the top-level /i flag would break the [A-Z]{3} IATA guard in
  // the same alternation, so each ASCII letter is expanded to a character
  // class via `ci` below. The helper hard-fails on regex metacharacters so a
  // future addition to the phrase list cannot silently inject regex syntax.
  //
  // Phrase coverage: bare chain words (via / layover / through / connecting /
  // stopover) plus phrase-form variants that close the currency/IATA overlap
  // for `stop`-family chained routes ("stopping at", "stops in", "with a
  // stop at", "connection in"). Bare `stop`/`stops`/`stopping` is NOT
  // blocked because real flight-card metadata (`1 stop`, `Nonstop`) sits in
  // the 80-char gap on legitimate pages.
  const ci = (word: string): string => {
    if (!/^[a-z]+$/.test(word)) {
      throw new Error(`pageHasRequestedRoute: ci() expects lowercase ASCII letters only, got ${JSON.stringify(word)}`);
    }
    return word.split('').map((ch) => `[${ch}${ch.toUpperCase()}]`).join('');
  };
  const chainPhrases = [
    ci('via'),
    ci('layover'),
    ci('through'),
    ci('connecting'),
    ci('stopover'),
    // "stop over" / "stop-over"
    `${ci('stop')}[-\\s]+${ci('over')}`,
    // "stop at"/"stop in"/"stops at"/"stops in"
    `${ci('stop')}${ci('s')}?\\s+${ci('at')}`,
    `${ci('stop')}${ci('s')}?\\s+${ci('in')}`,
    // "stopping at"/"stopping in"
    `${ci('stopping')}\\s+(?:${ci('at')}|${ci('in')})`,
    // "with stop"/"with a stop"/"with stopover"/"with a stopover"
    `${ci('with')}\\s+(?:${ci('a')}\\s+)?${ci('stop')}(?:${ci('over')})?`,
    // "connection"/"connection at"/"connection in"/"connection through"
    `${ci('connection')}(?:\\s+(?:${ci('at')}|${ci('in')}|${ci('through')}))?`,
  ];
  const blockingChainKeyword = `\\b(?:${chainPhrases.join('|')})\\b`;
  const noOtherIata = `(?:(?!${blockingChainKeyword})(?!\\b(?!(?:${allowedInGap})\\b)[A-Z]{3}\\b)[\\s\\S])`;
  const strict: RegExp[] = [
    // "from BDS to JFK" / "from BDS Brindisi to John F. Kennedy JFK".
    new RegExp(`\\bfrom\\s+${o}\\b${noOtherIata}{0,80}\\bto\\b${noOtherIata}{0,80}\\b${d}\\b`),
    // "BDS to JFK" / "BDS Brindisi to JFK" with no other IATA in between.
    new RegExp(`\\b${o}\\b${noOtherIata}{0,80}\\bto\\b${noOtherIata}{0,80}\\b${d}\\b`),
    // "BDS → JFK" / "BDS ⇒ JFK" — immediate adjacency.
    new RegExp(`\\b${o}\\s*[→⇒]\\s*${d}\\b`),
    // "BDS - JFK" / "BDS – JFK" / "BDS — JFK" / "BDS-JFK" — immediate adjacency.
    new RegExp(`\\b${o}\\s*[-–—]\\s*${d}\\b`),
  ];

  return strict.some((re) => re.test(pageText));
}

/**
 * Detect the specific failure mode reported in #65: Google strips the `q`
 * parameter and redirects to the bare /travel/flights homepage. The input
 * URL has a q param; the resolved URL does not.
 */
export function pageRedirectedToHomepage(inputUrl: string, finalUrl: string, paramName: string = 'q'): boolean {
  try {
    const had = new URL(inputUrl).searchParams.has(paramName);
    const has = new URL(finalUrl).searchParams.has(paramName);
    return had && !has;
  } catch {
    return false;
  }
}
