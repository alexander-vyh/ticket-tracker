import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSsrHtml } from './ssr-parse';

// oracle: fixtures are REAL Google Flights SSR responses captured live on
// 2026-07-10 via the tfs URLs built by tfs-builder (see scratch capture script
// provenance in git history): adults-only-with-results.html is LAX-AKL RT
// 2026-12-18/2027-01-08 for 3 adults, which Google served with inventory
// (independently confirmed at $6,448 cheapest in a real browser the same day);
// deferred-5pax.html is the same trip for 3 adults + 2 children, which Google
// defers out of SSR (payload slot 3 is null) — confirmed in a real browser to
// be a query Google understands (renders the 5-passenger widget). Google's
// actual behavior, not our code, defines these expectations.

const fx = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

describe('parseSsrHtml positive control (adults-only, has inventory)', () => {
  it('parses real flights with plausible family-route prices', () => {
    const result = parseSsrHtml(fx('adults-only-with-results.html'));
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.flights.length).toBeGreaterThan(0);
    for (const f of result.flights) {
      // 3 adults LAX->AKL round trip over the holidays: total must be
      // 4-figure-per-seat territory; a per-seat or corrupted price would fail.
      expect(f.price).toBeGreaterThan(1000);
      expect(f.price).toBeLessThan(40000);
      expect(f.airlines.length).toBeGreaterThan(0);
      expect(f.legs.length).toBeGreaterThan(0);
      expect(f.legs[0]!.fromAirport).toBe('LAX');
    }
    // the browser-confirmed cheapest that day was $6,448
    const cheapest = Math.min(...result.flights.map((f) => f.price));
    expect(cheapest).toBeGreaterThanOrEqual(4000);
    expect(cheapest).toBeLessThanOrEqual(12000);
  });
});

describe('parseSsrHtml negative control (children => deferred)', () => {
  it('reports deferred, never ok-with-zero-flights', () => {
    const result = parseSsrHtml(fx('deferred-5pax.html'));
    expect(result.status).toBe('deferred');
  });

  it('reports error (not deferred, not empty-ok) on unrecognizable html', () => {
    const result = parseSsrHtml('<html><body>captcha wall</body></html>');
    expect(result.status).toBe('error');
  });
});
