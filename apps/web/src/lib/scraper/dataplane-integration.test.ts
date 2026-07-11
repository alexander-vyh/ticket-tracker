import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TfsQuery } from '../dataplane/tfs-builder';
import type { PriceData } from './extract-prices';
import type { FlightSearchParams } from './navigate';

// oracle: the no_options/throttled disambiguation asserted below is the exact
// review amendment on ticket-tracker-uwj — measured 2026-07-10: a soft-blocked
// browser tier read "No results returned" for 5 adults on LAX-AKL Dec18/Jan8
// while an SSR fetch of the same route simultaneously priced it at $6,448.
// no_options may ONLY be recorded when a same-run canary confirms inventory
// is actually visible; otherwise the correct state is 'throttled'.

const { mockNavigateGoogleFlights, mockNavigateGoogleFlightsUrl, mockExtractPrices, mockFetchSsr } = vi.hoisted(() => ({
  mockNavigateGoogleFlights: vi.fn(),
  mockNavigateGoogleFlightsUrl: vi.fn(),
  mockExtractPrices: vi.fn(),
  mockFetchSsr: vi.fn(),
}));

vi.mock('./navigate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./navigate')>();
  return {
    ...actual,
    navigateGoogleFlights: (...args: unknown[]) => mockNavigateGoogleFlights(...args),
    navigateGoogleFlightsUrl: (...args: unknown[]) => mockNavigateGoogleFlightsUrl(...args),
  };
});

vi.mock('./extract-prices', () => ({
  extractPrices: (...args: unknown[]) => mockExtractPrices(...args),
}));

vi.mock('../dataplane/ssr-fetch', () => ({
  fetchSsr: (...args: unknown[]) => mockFetchSsr(...args),
}));

import {
  pairToTfsQuery,
  adultsOnlyVariant,
  priceDataToDataplaneFlight,
  createFetchBrowserAdapter,
  createCanaryHasInventory,
  runTwoTierGoogleFlights,
} from './dataplane-integration';

const PAIR_PARAMS: FlightSearchParams = {
  origin: 'LAX',
  destination: 'AKL',
  dateFrom: new Date('2026-12-18'),
  dateTo: new Date('2027-01-08'),
  tripType: 'round_trip',
  cabinClass: 'economy',
  currency: 'USD',
};

const FILTERS = {
  maxPrice: null,
  maxStops: null,
  maxDurationHours: null,
  preferredAirlines: [],
  timePreference: 'any',
  cabinClass: 'economy',
};

const SAMPLE_PRICE: PriceData = {
  travelDate: '2026-12-18',
  price: 6448,
  currency: 'USD',
  airline: 'American',
  bookingUrl: 'https://example.com',
  stops: 0,
  duration: '13h 0m',
  departureTime: '1:00 PM',
  arrivalTime: '7:30 AM',
  seatsLeft: null,
  flightNumber: 'AA 123',
};

describe('pairToTfsQuery', () => {
  it('maps a round-trip pair into outbound+return segments with the given passenger counts', () => {
    const q = pairToTfsQuery(PAIR_PARAMS, { adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 0 });
    expect(q.trip).toBe('round-trip');
    expect(q.seat).toBe('economy');
    expect(q.segments).toEqual([
      { date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' },
      { date: '2027-01-08', fromAirport: 'AKL', toAirport: 'LAX' },
    ]);
    expect(q.passengers).toEqual({ adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 0 });
  });

  it('maps a one-way pair into a single outbound segment', () => {
    const q = pairToTfsQuery({ ...PAIR_PARAMS, tripType: 'one_way' }, { adults: 1, children: 0, infantsInSeat: 0, infantsOnLap: 0 });
    expect(q.trip).toBe('one-way');
    expect(q.segments).toEqual([{ date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' }]);
  });

  it('maps cabinClass to the tfs seat enum, defaulting unknown values to economy', () => {
    expect(pairToTfsQuery({ ...PAIR_PARAMS, cabinClass: 'business' }, { adults: 1, children: 0, infantsInSeat: 0, infantsOnLap: 0 }).seat).toBe('business');
    expect(pairToTfsQuery({ ...PAIR_PARAMS, cabinClass: 'not-a-real-cabin' }, { adults: 1, children: 0, infantsInSeat: 0, infantsOnLap: 0 }).seat).toBe('economy');
  });
});

describe('adultsOnlyVariant', () => {
  it('strips children and infants, keeping adults (the canary query for the 3ad+2ch canonical case)', () => {
    const family: TfsQuery = {
      trip: 'round-trip',
      seat: 'economy',
      segments: [{ date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' }],
      passengers: { adults: 3, children: 2, infantsInSeat: 1, infantsOnLap: 1 },
    };
    expect(adultsOnlyVariant(family).passengers).toEqual({ adults: 3, children: 0, infantsInSeat: 0, infantsOnLap: 0 });
  });

  it('floors adults at 1 when the source query somehow has zero adults', () => {
    const zeroAdults: TfsQuery = {
      trip: 'one-way',
      seat: 'economy',
      segments: [{ date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' }],
      passengers: { adults: 0, children: 1 },
    };
    expect(adultsOnlyVariant(zeroAdults).passengers.adults).toBe(1);
  });
});

describe('priceDataToDataplaneFlight', () => {
  it('maps price and airline; DataplaneFlight only needs to support the orchestrator ok/empty check', () => {
    const flight = priceDataToDataplaneFlight(SAMPLE_PRICE, 'LAX', 'AKL');
    expect(flight.price).toBe(6448);
    expect(flight.airlines).toEqual(['American']);
    expect(flight.legs[0]!.fromAirport).toBe('LAX');
    expect(flight.legs[0]!.toAirport).toBe('AKL');
  });
});

describe('createFetchBrowserAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const tfsQuery: TfsQuery = {
    trip: 'round-trip',
    seat: 'economy',
    segments: [
      { date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' },
      { date: '2027-01-08', fromAirport: 'AKL', toAirport: 'LAX' },
    ],
    passengers: { adults: 3, children: 2 },
  };

  it('uses the tfs URL result directly when it finds results, without falling back to the legacy path', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '<html>tfs</html>', url: 'https://tfs.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [SAMPLE_PRICE], usage: { inputTokens: 10, outputTokens: 5 } });

    const adapter = createFetchBrowserAdapter({
      pairParams: PAIR_PARAMS, filters: FILTERS, countryProfile: undefined, proxyUrl: undefined, travelDateFallback: '2026-12-18',
    });
    const result = await adapter.fetchBrowser(tfsQuery);

    expect(mockNavigateGoogleFlightsUrl).toHaveBeenCalledTimes(1);
    expect(mockNavigateGoogleFlights).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'ok', flights: [priceDataToDataplaneFlight(SAMPLE_PRICE, 'LAX', 'AKL')] });
    expect(adapter.getPrices()).toEqual([SAMPLE_PRICE]);
  });

  it('falls back to the legacy q= path when tfs navigation finds no results', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'https://tfs.example', resultsFound: false, source: 'google_flights' });
    mockNavigateGoogleFlights.mockResolvedValue({ html: '<html>legacy</html>', url: 'https://legacy.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [SAMPLE_PRICE], usage: { inputTokens: 10, outputTokens: 5 } });

    const adapter = createFetchBrowserAdapter({
      pairParams: PAIR_PARAMS, filters: FILTERS, countryProfile: undefined, proxyUrl: undefined, travelDateFallback: '2026-12-18',
    });
    await adapter.fetchBrowser(tfsQuery);

    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(1);
    expect(mockExtractPrices).toHaveBeenCalledTimes(1);
    expect(mockExtractPrices).toHaveBeenCalledWith('<html>legacy</html>', 'https://legacy.example', '2026-12-18', FILTERS, undefined, true, 'google_flights', 'USD');
  });

  it('falls back to the legacy path (does not propagate) when tfs navigation itself throws', async () => {
    mockNavigateGoogleFlightsUrl.mockRejectedValue(new Error('tfs nav crashed'));
    mockNavigateGoogleFlights.mockResolvedValue({ html: '<html>legacy</html>', url: 'https://legacy.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [SAMPLE_PRICE], usage: { inputTokens: 10, outputTokens: 5 } });

    const adapter = createFetchBrowserAdapter({
      pairParams: PAIR_PARAMS, filters: FILTERS, countryProfile: undefined, proxyUrl: undefined, travelDateFallback: '2026-12-18',
    });
    const result = await adapter.fetchBrowser(tfsQuery);

    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
  });

  it('propagates an exception thrown by the legacy fallback path unchanged (preserves the existing aggregator-chain error-surfacing contract)', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'https://tfs.example', resultsFound: false, source: 'google_flights' });
    mockNavigateGoogleFlights.mockRejectedValue(new Error('browser crashed'));

    const adapter = createFetchBrowserAdapter({
      pairParams: PAIR_PARAMS, filters: FILTERS, countryProfile: undefined, proxyUrl: undefined, travelDateFallback: '2026-12-18',
    });

    await expect(adapter.fetchBrowser(tfsQuery)).rejects.toThrow('browser crashed');
  });

  it('returns an empty (not error) BrowserFetchResult when extraction yields zero prices, so the orchestrator can consult the canary', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '<html>tfs</html>', url: 'https://tfs.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [], usage: { inputTokens: 10, outputTokens: 5 }, failureReason: undefined });

    const adapter = createFetchBrowserAdapter({
      pairParams: PAIR_PARAMS, filters: FILTERS, countryProfile: undefined, proxyUrl: undefined, travelDateFallback: '2026-12-18',
    });
    const result = await adapter.fetchBrowser(tfsQuery);

    expect(result).toEqual({ status: 'ok', flights: [] });
  });
});

describe('createCanaryHasInventory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches SSR on the adults-only variant and returns true when it finds inventory', async () => {
    mockFetchSsr.mockResolvedValue({ status: 'ok', flights: [{ price: 6448, airlines: ['American'], legs: [] }] });
    const canary = createCanaryHasInventory({ currency: 'USD' });

    const familyQuery: TfsQuery = {
      trip: 'round-trip', seat: 'economy',
      segments: [{ date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' }],
      passengers: { adults: 3, children: 2 },
    };
    const ok = await canary(familyQuery);

    expect(ok).toBe(true);
    expect(mockFetchSsr).toHaveBeenCalledTimes(1);
    const [calledQuery] = mockFetchSsr.mock.calls[0]!;
    expect((calledQuery as TfsQuery).passengers).toEqual({ adults: 3, children: 0, infantsInSeat: 0, infantsOnLap: 0 });
  });

  it('returns false when SSR finds nothing (the throttled signal, not sold-out)', async () => {
    mockFetchSsr.mockResolvedValue({ status: 'ok', flights: [] });
    const canary = createCanaryHasInventory({ currency: 'USD' });
    const ok = await canary({ trip: 'one-way', seat: 'economy', segments: [], passengers: { adults: 1 } });
    expect(ok).toBe(false);
  });

  it('returns false when SSR defers rather than throwing (deferred is not evidence of inventory)', async () => {
    mockFetchSsr.mockResolvedValue({ status: 'deferred' });
    const canary = createCanaryHasInventory({ currency: 'USD' });
    const ok = await canary({ trip: 'one-way', seat: 'economy', segments: [], passengers: { adults: 1 } });
    expect(ok).toBe(false);
  });
});

describe('runTwoTierGoogleFlights (full integration through the real orchestrateScrape)', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseDeps = {
    passengers: { adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 0 },
    pairParams: PAIR_PARAMS,
    filters: FILTERS,
    countryProfile: undefined,
    proxyUrl: undefined,
    travelDateFallback: '2026-12-18',
    browserBudget: 5,
  };

  it('positive control: empty browser + canary confirms inventory => no_options, zero prices, canaryOk=true', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'https://tfs.example', resultsFound: false, source: 'google_flights' });
    mockNavigateGoogleFlights.mockResolvedValue({ html: '<html>no flights</html>', url: 'https://legacy.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [], usage: { inputTokens: 10, outputTokens: 5 } });
    // Canary (adults-only SSR) sees real inventory — the "healthy connection, genuinely sold out" case.
    mockFetchSsr.mockResolvedValue({ status: 'ok', flights: [{ price: 6448, airlines: ['American'], legs: [] }] });

    const result = await runTwoTierGoogleFlights(baseDeps);

    expect(result.availability).toBe('no_options');
    expect(result.prices).toEqual([]);
    expect(result.canaryOk).toBe(true);
  });

  it('negative control: empty browser + canary ALSO empty => throttled, NOT no_options, zero prices', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'https://tfs.example', resultsFound: false, source: 'google_flights' });
    mockNavigateGoogleFlights.mockResolvedValue({ html: '<html>no flights</html>', url: 'https://legacy.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [], usage: { inputTokens: 10, outputTokens: 5 } });
    // Canary (adults-only SSR) is ALSO empty — the soft-blocked/throttled case.
    mockFetchSsr.mockResolvedValue({ status: 'ok', flights: [] });

    const result = await runTwoTierGoogleFlights(baseDeps);

    expect(result.availability).toBe('throttled');
    expect(result.prices).toEqual([]);
    expect(result.canaryOk).toBe(false);
  });

  it('available path: browser finds real flights => availability available, real PriceData preserved, canary never consulted', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'https://tfs.example', resultsFound: false, source: 'google_flights' });
    mockNavigateGoogleFlights.mockResolvedValue({ html: '<html>flights</html>', url: 'https://legacy.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [SAMPLE_PRICE], usage: { inputTokens: 10, outputTokens: 5 } });

    const result = await runTwoTierGoogleFlights(baseDeps);

    expect(result.availability).toBe('available');
    expect(result.prices).toEqual([SAMPLE_PRICE]);
    expect(result.canaryOk).toBeNull();
    expect(mockFetchSsr).not.toHaveBeenCalled();
  });
});
