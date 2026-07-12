/**
 * Extraction RECALL measurement against the real local model (ticket-tracker-zep).
 *
 * WHY THIS EXISTS
 * ticket-tracker-gvh made the CAP safe: extractPrices now sorts ascending by price
 * and THEN slices, so the cap can only drop the DEAREST flights. But that only
 * protects flights the model actually EMITTED. It cannot help if the model, handed
 * a page of ~100 flights, never emits the cheapest one at all — we would be sorting
 * a set that was already missing the answer, and pricer.ts would report
 * min-over-that-set as the trip's cheapest fare.
 *
 * Whether that happens is a property of the MODEL, not of our code, so it can only
 * be measured. This test buries the true minimum deep in DOM order on a 100-flight
 * page and asks whether it comes back.
 *
 * WHAT IT MEASURED (qwen3.6-35b-dwq, 2026-07-11)
 *  - The pre-gvh prompt (cap 10, incl. the "prefer variety" rule) FOUND the buried
 *    $496 fare and returned a clean cheapest-first list of 10. The variety rule did
 *    NOT crowd out cheap fares as feared — the model ignored it. So the pre-gvh
 *    code was a latent hazard, not an actively-firing bug.
 *  - The current prompt at cap 10 is identical: 10 rows, finds $496.
 *  - The current prompt at cap 30 returns only THREE rows (deterministic across
 *    runs; ~332 output tokens, finish_reason=stop — the model simply chooses to
 *    emit 3). It still finds $496. Asking for MORE yields FEWER: instruction
 *    following degrades as the ask grows. This is why the default cap stayed at 10.
 *  - The model itself is capable of 30 rows (a trimmed prompt gets all 30, and our
 *    parser handles them), so the collapse is prompt-sensitivity, not a hard limit.
 *  - LATENCY: a 10-row extraction of a 100-flight page takes ~180s on this model,
 *    which EXCEEDS the 90s default EXTRACT_TIMEOUT_MS and aborts to `llm_error`.
 *    Hence extractTimeoutSeconds below.
 *
 * Gated on RUN_LLM_INTEGRATION=1 so the default suite stays hermetic and fast:
 *   RUN_LLM_INTEGRATION=1 npx vitest run src/lib/scraper/extraction-recall.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { appendFileSync } from 'node:fs';
import { EXTRACTION_PROVIDERS } from './ai-registry';
import { extractPrices, extractJsonArray, coercePrice, type QueryFilters } from './extract-prices';

/** vitest swallows console.log in this project, so measurements are appended here. */
const REPORT = process.env.RECALL_REPORT ?? '/tmp/recall-report.txt';
function report(line: string): void {
  appendFileSync(REPORT, line + '\n');
}

const BASE_URL = process.env.OPENAI_BASE_URL_HOST ?? 'http://127.0.0.1:8000/v1';
const API_KEY = process.env.OPENAI_API_KEY ?? 'local-mlx-no-key';
const MODEL = process.env.RECALL_MODEL ?? 'qwen3.6-35b-dwq';
const ENABLED = process.env.RUN_LLM_INTEGRATION === '1';

/** The fare buried deep in the page. Nothing else on the page is cheaper. */
const TRUE_MIN = 496;
/** 0-based DOM position of the true minimum — deep enough that a model reading
 *  only the top of the list will miss it. */
const TRUE_MIN_INDEX = 88;
const TOTAL_FLIGHTS = 100;

const CARRIERS = [
  'Air New Zealand', 'United', 'Delta', 'American', 'Qantas', 'Hawaiian',
  'Cathay Pacific', 'Jetstar', 'Korean Air', 'Singapore Airlines',
];

/**
 * A Google-Flights-shaped innerText page carrying TOTAL_FLIGHTS results. Prices
 * are deliberately NOT ascending — Google's default view is a relevance ranking,
 * so the cheapest fare is not first.
 */
function buildPage(): string {
  const lines: string[] = [
    'Google Flights', '',
    'Flights from Los Angeles to Auckland', '',
    'Showing results for Dec 10 – Dec 28', '',
    'Departing flights', '',
  ];
  for (let i = 0; i < TOTAL_FLIGHTS; i++) {
    const isMin = i === TRUE_MIN_INDEX;
    // Every other fare is strictly dearer than TRUE_MIN, spread over 700..2400
    // with no ordering signal.
    const price = isMin ? TRUE_MIN : 700 + ((i * 137) % 1700);
    const airline = isMin ? 'Fiji Airways' : CARRIERS[i % CARRIERS.length]!;
    const stops = i % 3;
    const depHour = 6 + (i % 16);
    lines.push(
      airline,
      `${depHour}:15 AM – ${(depHour + 7) % 24}:40 PM`,
      'LAX – AKL',
      stops === 0 ? 'Nonstop · 13h 05m' : `${stops} stop${stops > 1 ? 's' : ''} · ${13 + stops * 4}h 30m`,
      `$${price}`,
      'Dec 10',
      '',
    );
  }
  return lines.join('\n');
}

const PAGE = buildPage();

const FILTERS: QueryFilters = {
  maxPrice: null, maxStops: null, maxDurationHours: null,
  preferredAirlines: [], timePreference: 'any', cabinClass: 'economy',
};

const CONFIG_OVERRIDE = {
  provider: 'openai',
  model: MODEL,
  customBaseUrl: BASE_URL,
  apiKey: API_KEY,
  maxFlightsPerDate: 10,
  // qwen3 is a reasoning model and is slow on a 100-flight page; the 90s default
  // aborts it (llm_error). Give it room so we measure the PROMPT, not the timeout.
  extractTimeoutSeconds: 300,
};

/**
 * The pre-gvh prompt (commit 0a70a37~1), reproduced so the A/B is honest: this is
 * what was actually shipping, including the "prefer variety" rule that competes
 * with cheapest-first selection and that zep suspected of hiding cheap fares.
 */
function legacySystemPrompt(maxResults: number): string {
  return `You are a flight price data extractor. Given the visible text content from a Google Flights search results page, extract the best matching flight options.

Return ONLY valid JSON — an array of UP TO ${maxResults} objects with this exact shape:
[{"travelDate":"YYYY-MM-DD","price":623,"currency":"USD","airline":"Delta","bookingUrl":"https://...","stops":1,"duration":"11h 20m","departureTime":"10:25 AM","arrivalTime":"4:45 PM","seatsLeft":3,"flightNumber":"DL 345"}]

General rules:
- Return at most ${maxResults} results, sorted by price (cheapest first)
- Price must be a number (no $ sign, no commas)
- Prefer variety: if multiple airlines are available, include at least one from each (up to the ${maxResults} limit)
- Return ONLY the JSON array, no markdown, no explanation
- If you cannot extract any flights, return an empty array []`;
}

describe.skipIf(!ENABLED)('extraction recall on a 100-flight page (ticket-tracker-zep)', () => {
  it('LEGACY prompt (cap 10 + "prefer variety") still surfaces the buried cheapest fare', async () => {
    const result = await EXTRACTION_PROVIDERS.openai!.extract(
      API_KEY,
      MODEL,
      legacySystemPrompt(10),
      `Search URL: https://flights.google.com\nDefault travel date: 2026-12-10\n\n${PAGE}`,
      { baseUrl: BASE_URL, timeoutMs: 300_000 },
    );
    const parsed = extractJsonArray(result.content);
    const prices = parsed.ok
      ? parsed.value.map((e) => coercePrice((e as Record<string, unknown>).price)).filter((p) => p > 0)
      : [];
    const min = prices.length ? Math.min(...prices) : null;

    report(`LEGACY cap=10 -> ${prices.length} rows; min=$${min} (true=$${TRUE_MIN}); prices=${JSON.stringify(prices)}`);

    // The finding that DISPROVED zep's hypothesis: the "prefer variety" rule did
    // not crowd out the cheapest fare. The model ignored it and ranked by price.
    expect(min).toBe(TRUE_MIN);
  }, 320_000);

  it('CURRENT prompt surfaces the buried cheapest fare through the real extractPrices path', async () => {
    const result = await extractPrices(
      PAGE, 'https://flights.google.com', '2026-12-10',
      FILTERS, undefined, true, 'google_flights', 'USD',
      CONFIG_OVERRIDE,
    );
    const prices = result.prices.map((p) => p.price);
    const min = prices.length ? Math.min(...prices) : null;

    report(`CURRENT cap=10 -> ${prices.length} rows; min=$${min} (true=$${TRUE_MIN}); outputTokens=${result.usage.outputTokens}; prices=${JSON.stringify(prices)}`);

    // The contract that actually matters: the fare we report as cheapest IS the
    // cheapest fare on the page, even though it sits 88 results deep.
    expect(result.failureReason).toBeUndefined();
    expect(min).toBe(TRUE_MIN);
    expect(result.prices[0]!.price).toBe(TRUE_MIN);
    expect(result.prices[0]!.airline).toContain('Fiji');
  }, 320_000);

  it('raising the cap to 30 does NOT yield more options on this model (it yields fewer)', async () => {
    const result = await extractPrices(
      PAGE, 'https://flights.google.com', '2026-12-10',
      FILTERS, undefined, true, 'google_flights', 'USD',
      { ...CONFIG_OVERRIDE, maxFlightsPerDate: 30 },
    );
    const prices = result.prices.map((p) => p.price);
    const min = prices.length ? Math.min(...prices) : null;

    report(`CURRENT cap=30 -> ${prices.length} rows; min=$${min} (true=$${TRUE_MIN}); outputTokens=${result.usage.outputTokens}; prices=${JSON.stringify(prices)}`);

    // Documents the counterintuitive result that kept the default at 10: asking
    // for 30 makes qwen3 emit ~3 rows. The MINIMUM is still correct — the sort +
    // slice guarantees that — but the alternatives list collapses. Asserted as a
    // loose bound so a better-behaved model does not fail the suite.
    expect(min).toBe(TRUE_MIN);
    expect(prices.length).toBeLessThan(30);
  }, 320_000);
});
