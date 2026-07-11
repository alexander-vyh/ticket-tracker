import { describe, expect, it } from 'vitest';
import { buildTfs, buildTfsUrl, type TfsQuery } from './tfs-builder';

// oracle: golden tfs strings below were captured 2026-07-10 from fast-flights'
// reference encoder AND independently verified against Google Flights itself in
// a real browser session: Google rendered the correct route, dates, cabin and
// passenger widget ("5 · 3 adults · 2 children") for each string, and returned
// live results where inventory existed (see .research/flight-tracker-2026-07-10/
// 04-ts-runner.md and the design doc's walking-skeleton section). Google's own
// interpretation of these strings — not our implementation — is the source of truth.

const NZ_RT_BASE: Omit<TfsQuery, 'passengers'> = {
  trip: 'round-trip',
  seat: 'economy',
  segments: [
    { date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2027-01-08', fromAirport: 'AKL', toAirport: 'LAX' },
  ],
};

describe('buildTfs golden strings (verified against Google 2026-07-10)', () => {
  it('encodes the canonical NZ family round trip (3 adults + 2 children)', () => {
    expect(buildTfs({ ...NZ_RT_BASE, passengers: { adults: 3, children: 2 } })).toBe(
      'GhoSCjIwMjYtMTItMThqBRIDTEFYcgUSA0FLTBoaEgoyMDI3LTAxLTA4agUSA0FLTHIFEgNMQVhCBQEBAQICSAGYAQE=',
    );
  });

  it('encodes a one-way with the same passengers (trip enum differs)', () => {
    expect(
      buildTfs({
        trip: 'one-way',
        seat: 'economy',
        segments: [{ date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' }],
        passengers: { adults: 3, children: 2 },
      }),
    ).toBe('GhoSCjIwMjYtMTItMThqBRIDTEFYcgUSA0FLTEIFAQEBAgJIAZgBAg==');
  });

  it('encodes 2 adults + 2 children round trip', () => {
    expect(buildTfs({ ...NZ_RT_BASE, passengers: { adults: 2, children: 2 } })).toBe(
      'GhoSCjIwMjYtMTItMThqBRIDTEFYcgUSA0FLTBoaEgoyMDI3LTAxLTA4agUSA0FLTHIFEgNMQVhCBAEBAgJIAZgBAQ==',
    );
  });

  it('encodes 3 adults + 1 child round trip', () => {
    expect(buildTfs({ ...NZ_RT_BASE, passengers: { adults: 3, children: 1 } })).toBe(
      'GhoSCjIwMjYtMTItMThqBRIDTEFYcgUSA0FLTBoaEgoyMDI3LTAxLTA4agUSA0FLTHIFEgNMQVhCBAEBAQJIAZgBAQ==',
    );
  });
});

describe('buildTfs semantic controls', () => {
  it('children are NOT encoded as extra adults (negative control)', () => {
    // 5 adults and 3ad+2ch must produce different strings; Google prices
    // child fares differently and the walking skeleton showed availability
    // differs by passenger mix.
    const fiveAdults = buildTfs({ ...NZ_RT_BASE, passengers: { adults: 5 } });
    const family = buildTfs({ ...NZ_RT_BASE, passengers: { adults: 3, children: 2 } });
    expect(fiveAdults).not.toBe(family);
  });

  it('rejects more than 9 passengers (Google hard limit)', () => {
    expect(() =>
      buildTfs({ ...NZ_RT_BASE, passengers: { adults: 8, children: 2 } }),
    ).toThrow(/9/);
  });

  it('rejects lap infants exceeding adults (airline rule)', () => {
    expect(() =>
      buildTfs({ ...NZ_RT_BASE, passengers: { adults: 1, infantsOnLap: 2 } }),
    ).toThrow(/lap/i);
  });

  it('rejects a round trip without exactly two segments', () => {
    expect(() =>
      buildTfs({
        trip: 'round-trip',
        seat: 'economy',
        segments: [{ date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' }],
        passengers: { adults: 1 },
      }),
    ).toThrow(/segment/i);
  });
});

describe('buildTfsUrl', () => {
  it('produces a Google Flights search URL with hl/gl/curr pinned', () => {
    const url = buildTfsUrl(
      { ...NZ_RT_BASE, passengers: { adults: 3, children: 2 } },
      { hl: 'en', gl: 'US', curr: 'USD' },
    );
    expect(url).toBe(
      'https://www.google.com/travel/flights/search?tfs=' +
        encodeURIComponent(
          'GhoSCjIwMjYtMTItMThqBRIDTEFYcgUSA0FLTBoaEgoyMDI3LTAxLTA4agUSA0FLTHIFEgNMQVhCBQEBAQICSAGYAQE=',
        ) +
        '&hl=en&gl=US&curr=USD',
    );
  });
});
