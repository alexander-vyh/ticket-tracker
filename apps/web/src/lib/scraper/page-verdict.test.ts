import { describe, expect, it } from 'vitest';
import { pageShowsNoOptions } from './page-verdict';

// oracle: captured 2026-07-11 from the real Google Flights empty-results page
// for LAX->AKL 2026-12-08/2026-12-31, 3 adults + 2 children. Reproduced
// byte-for-byte in BOTH the container's headless Chromium and a real desktop
// Chrome on a residential IP, which is what established that Google is
// answering the query rather than blocking the browser.
const REAL_NO_OPTIONS_PAGE = [
  'Skip to main content',
  'Accessibility feedback',
  'Explore',
  'Flights',
  'Sign in',
  'Loading results',
  'Flight search',
  'Round trip',
  '5',
  'Economy',
  'Los Angeles LAX',
  'Auckland AKL',
  'Filters',
  'Search results',
  'No results returned.',
  'No options matching your search',
  'Try changing your dates or destination to see results',
  'Language​English (United States)',
].join('\n');

describe('pageShowsNoOptions — "Google answered: nothing available" vs "we never got an answer"', () => {
  it('recognizes the real Google Flights empty-results page for the requested route', () => {
    expect(pageShowsNoOptions(REAL_NO_OPTIONS_PAGE, 'LAX', 'AKL')).toBe(true);
  });

  it('does NOT fire for a route the page never mentions', () => {
    // Same empty-results page, but we asked about a different city pair. If this
    // returned true we would record JFK->LHR as sold out on the strength of a
    // page about LAX->AKL.
    expect(pageShowsNoOptions(REAL_NO_OPTIONS_PAGE, 'JFK', 'LHR')).toBe(false);
  });

  it('does NOT fire on a block/interstitial page that lacks the search header', () => {
    // The dangerous false positive: a page that says something no-results-ish but
    // never rendered the Flights search UI carries NO market signal. Treating it
    // as an answer would let a bot-block masquerade as "sold out".
    const blockPage =
      'Our systems have detected unusual traffic from your computer network. ' +
      'No results returned. Please try your request again later.';
    expect(pageShowsNoOptions(blockPage, 'LAX', 'AKL')).toBe(false);
  });

  it('does NOT fire on a page with no empty-results phrase at all', () => {
    const resultsPage =
      'Flight search Round trip 5 Economy Los Angeles LAX Auckland AKL ' +
      'Search results 6 results returned. Best Cheapest from $845';
    expect(pageShowsNoOptions(resultsPage, 'LAX', 'AKL')).toBe(false);
  });

  it('requires BOTH airports — a page naming only the origin is not an answer about the route', () => {
    const partial = 'Flight search Los Angeles LAX No options matching your search';
    expect(pageShowsNoOptions(partial, 'LAX', 'AKL')).toBe(false);
  });

  it('does not match an airport code embedded in a longer token', () => {
    // Word-boundary guard: "RELAX" must not satisfy the LAX requirement.
    const text = 'RELAX No options matching your search AKLAND';
    expect(pageShowsNoOptions(text, 'LAX', 'AKL')).toBe(false);
  });

  it('accepts the alternate "No flights found" phrasing Google uses on some locales', () => {
    const text = 'Flight search Los Angeles LAX Auckland AKL No flights found';
    expect(pageShowsNoOptions(text, 'LAX', 'AKL')).toBe(true);
  });
});
