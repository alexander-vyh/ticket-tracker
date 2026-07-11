/**
 * Tier-1 fetcher: plain HTTPS GET of a Google Flights tfs URL.
 *
 * No browser, no LLM — this surface proved throttle-resilient on 2026-07-10
 * while the headless-browser surface from the same IP was soft-blocked. The
 * SOCS cookie pre-acknowledges Google's consent interstitial so the real
 * results page is served.
 */
import type { TfsQuery, TfsUrlOptions } from './tfs-builder';
import { buildTfsUrl } from './tfs-builder';
import { parseSsrHtml } from './ssr-parse';
import type { SsrParseResult } from './types';

const SOCS_COOKIE = 'CAISHAgBEhJnd3NfMjAyNDA4MDYtMF9SQzIaAmVuIAEaBgiAo_C1Bg';

const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  cookie: `SOCS=${SOCS_COOKIE}`,
};

export interface SsrFetchOptions extends TfsUrlOptions {
  timeoutMs?: number;
}

/** Fetch and parse a query via the SSR tier. Network errors become status 'error'. */
export async function fetchSsr(
  query: TfsQuery,
  opts: SsrFetchOptions = {},
): Promise<SsrParseResult> {
  const url = buildTfsUrl(query, opts);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      redirect: 'follow',
    });
  } catch (err) {
    return { status: 'error', reason: `fetch failed: ${String(err)}` };
  }
  if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
  return parseSsrHtml(await res.text());
}
