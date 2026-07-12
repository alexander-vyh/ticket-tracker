import { describe, it, expect } from 'vitest';
import {
  parseItinerary,
  parseObservedParty,
  looksEmpty,
  looksBlocked,
  monotonicityCheck,
  type CellResult,
} from './flight-sweep';

const QANTAS_1STOP =
  'From 2,233 US dollars round trip total. 1 stop flight with Qantas. ' +
  'Leaves Los Angeles International Airport at 10:40 PM on Thursday, December 10 and ' +
  'arrives at Auckland Airport at 5:20 AM on Sunday, December 13. ' +
  'Total duration 23 hr 40 min. ' +
  'Layover (1 of 1) is a 3 hr 30 min layover at Melbourne Airport in Melbourne. Select flight';

const DELTA_NONSTOP =
  'From 745 US dollars round trip total. Nonstop flight with Delta. ' +
  'Leaves Los Angeles International Airport at 10:35 PM on Monday, December 1 and ' +
  'arrives at Auckland Airport at 8:45 AM on Wednesday, December 3. ' +
  'Total duration 13 hr 10 min. Select flight';

describe('parseItinerary', () => {
  it('parses price, stops, airline, layover and duration from a real aria-label', () => {
    const it3 = parseItinerary(QANTAS_1STOP, 3)!;
    expect(it3.totalPrice).toBe(2233);
    expect(it3.currency).toBe('USD');
    expect(it3.stops).toBe(1);
    expect(it3.airlines).toEqual(['Qantas']);
    expect(it3.layovers).toEqual(['Melbourne']);
    expect(it3.durationMinutes).toBe(23 * 60 + 40);
  });

  it('derives per-seat by dividing the party total — the price on the card is the PARTY TOTAL', () => {
    // Google's own scaling (1 adult $745 / 2 adults $1,489 / 3 adults $2,233)
    // proves the card price covers the whole party. Reporting $2,233 as a
    // per-seat fare, or $745 as a family total, are the two shipped bugs.
    expect(parseItinerary(QANTAS_1STOP, 3)!.perSeat).toBe(744);
    expect(parseItinerary(DELTA_NONSTOP, 1)!.perSeat).toBe(745);
  });

  it('treats a nonstop as zero stops with no layover', () => {
    const nonstop = parseItinerary(DELTA_NONSTOP, 1)!;
    expect(nonstop.stops).toBe(0);
    expect(nonstop.layovers).toEqual([]);
    expect(nonstop.durationMinutes).toBe(790);
  });

  it('returns null for role="link" nodes that are not itinerary cards', () => {
    expect(parseItinerary('Search flights', 3)).toBeNull();
    expect(parseItinerary('', 3)).toBeNull();
    expect(parseItinerary('From our partners. Learn more', 3)).toBeNull();
  });

  it('splits multi-carrier itineraries', () => {
    const label =
      'From 1,489 US dollars round trip total. 2 stops flight with Fiji Airways and Air New Zealand. ' +
      'Total duration 30 hr 5 min. Select flight';
    expect(parseItinerary(label, 2)!.airlines).toEqual(['Fiji Airways', 'Air New Zealand']);
  });
});

describe('parseObservedParty — the guard that stops a wrong-party price shipping', () => {
  it('reads the passenger count Google echoes back', () => {
    expect(
      parseObservedParty('Prices include required taxes + fees for 3 passengers.'),
    ).toBe(3);
    expect(parseObservedParty('Prices include required taxes + fees for 1 passenger.')).toBe(1);
  });

  it('returns null when the line is absent, so the caller refuses to report', () => {
    expect(parseObservedParty('Some other page text entirely')).toBeNull();
  });
});

describe('page verdicts', () => {
  it('detects the empty state', () => {
    expect(looksEmpty('No options matching your search')).toBe(true);
    expect(looksEmpty('Prices include required taxes + fees for 3 passengers')).toBe(false);
  });

  it('detects a bot interstitial but not a healthy results page', () => {
    expect(looksBlocked('Our systems have detected unusual traffic')).toBe(true);
    expect(
      looksBlocked('Prices include required taxes + fees for 3 passengers. reCAPTCHA'),
    ).toBe(false);
  });
});

const cell = (over: Partial<CellResult>): CellResult => ({
  label: 'LAX-AKL',
  url: 'https://example.test',
  party: 3,
  status: 'no-options',
  itineraries: [],
  cheapest: null,
  observedParty: null,
  ...over,
});

describe('monotonicityCheck — seat availability cannot grow with party size', () => {
  it('proves a 3-pax empty is FABRICATED when 1 adult is priced on the same cell', () => {
    const priced = parseItinerary(DELTA_NONSTOP, 1)!;
    const result = monotonicityCheck(
      cell({ status: 'no-options' }),
      cell({ party: 1, status: 'priced', itineraries: [priced], cheapest: priced }),
    );
    expect(result.genuine).toBe(false);
    expect(result.reason).toContain('FABRICATED');
  });

  it('accepts a sold-out only when the 1-adult control is also empty', () => {
    const result = monotonicityCheck(
      cell({ status: 'no-options' }),
      cell({ party: 1, status: 'no-options' }),
    );
    expect(result.genuine).toBe(true);
  });

  it('never blesses a sold-out on an inconclusive control', () => {
    expect(monotonicityCheck(cell({}), cell({ party: 1, status: 'error' })).genuine).toBe(false);
    expect(monotonicityCheck(cell({}), cell({ party: 1, status: 'blocked' })).genuine).toBe(false);
  });
});
