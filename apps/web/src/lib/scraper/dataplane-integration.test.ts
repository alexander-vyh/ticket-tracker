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
  dataplaneFlightToPriceData,
  createFetchBrowserAdapter,
  createCanaryHasInventory,
  runTwoTierGoogleFlights,
} from './dataplane-integration';
import type { DataplaneFlight } from '../dataplane/types';

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

  it('honors stored open-jaw segments instead of mirroring the origin/destination pair', () => {
    // LAX -> AKL out, then CHC -> LAX back: the return does NOT reverse the
    // outbound (different NZ gateway). The old behavior reconstructed a
    // round-trip AKL -> LAX return, silently pricing the wrong itinerary (k5m.5).
    const q = pairToTfsQuery(
      {
        ...PAIR_PARAMS,
        tripType: 'open_jaw',
        segments: [
          { from: 'LAX', to: 'AKL', date: '2026-12-18' },
          { from: 'CHC', to: 'LAX', date: '2027-01-08' },
        ],
      },
      { adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 0 },
    );
    expect(q.trip).toBe('open-jaw');
    expect(q.segments).toEqual([
      { date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' },
      { date: '2027-01-08', fromAirport: 'CHC', toAirport: 'LAX' },
    ]);
    expect(q.passengers).toEqual({ adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 0 });
  });

  it('maps a 3-leg multi-city itinerary straight through', () => {
    const q = pairToTfsQuery(
      {
        ...PAIR_PARAMS,
        tripType: 'multi_city',
        segments: [
          { from: 'LAX', to: 'AKL', date: '2026-12-18' },
          { from: 'AKL', to: 'ZQN', date: '2026-12-28' },
          { from: 'CHC', to: 'LAX', date: '2027-01-08' },
        ],
      },
      { adults: 2, children: 0, infantsInSeat: 0, infantsOnLap: 0 },
    );
    expect(q.trip).toBe('multi-city');
    expect(q.segments).toHaveLength(3);
    expect(q.segments[2]).toEqual({ date: '2027-01-08', fromAirport: 'CHC', toAirport: 'LAX' });
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

describe('dataplaneFlightToPriceData', () => {
  // oracle: direct payload evidence (Serena memory dataplane/ssr-roundtrip-legs-semantics,
  // ssr-builder agent, 2026-07-10, captured fixture adults-only-with-results.html,
  // LAX-AKL RT 2026-12-18/2027-01-08, 3 adults): every round-trip SSR option has
  // legs.length === 1 (outbound only — Google's SSR never renders return-leg
  // detail), while price is nonetheless the round-trip total ($6,448 measured).

  it('maps a round-trip SSR flight (outbound-only legs) using the outbound schedule and the RT total price', () => {
    const rtFlight: DataplaneFlight = {
      price: 6448,
      airlines: ['American'],
      legs: [
        {
          fromAirport: 'LAX', fromAirportName: 'Los Angeles', toAirport: 'AKL', toAirportName: 'Auckland',
          departureDate: [2026, 12, 18], departureTime: [13, 0], arrivalDate: [2026, 12, 19], arrivalTime: [7, 30],
          duration: 800, planeType: '787',
        },
      ],
    };
    const p = dataplaneFlightToPriceData(rtFlight, '2026-12-18', 'USD');

    expect(p.price).toBe(6448);
    expect(p.airline).toBe('American');
    expect(p.travelDate).toBe('2026-12-18');
    expect(p.departureTime).toBe('13:00');
    expect(p.arrivalTime).toBe('07:30');
    expect(p.duration).toBe('13h 20m');
    expect(p.stops).toBe(0);
    // No return-leg data exists in the SSR payload at all — never fabricated.
    expect(p.flightNumber).toBeNull();
    expect(p.bookingUrl).toBeNull();
  });

  it('falls back to the caller-supplied travel date when the leg carries no departure date', () => {
    const flight: DataplaneFlight = {
      price: 500,
      airlines: ['Delta'],
      legs: [{ fromAirport: 'JFK', fromAirportName: null, toAirport: 'LAX', toAirportName: null, departureDate: null, departureTime: null, arrivalDate: null, arrivalTime: null, duration: null, planeType: null }],
    };
    expect(dataplaneFlightToPriceData(flight, '2026-06-15', 'USD').travelDate).toBe('2026-06-15');
  });

  it('counts stops from the outbound leg segments only (2 segments = 1 stop)', () => {
    const leg = { fromAirport: 'LAX', fromAirportName: null, toAirport: 'HNL', toAirportName: null, departureDate: null, departureTime: null, arrivalDate: null, arrivalTime: null, duration: null, planeType: null };
    const flight: DataplaneFlight = { price: 900, airlines: ['United'], legs: [leg, { ...leg, fromAirport: 'HNL', toAirport: 'AKL' }] };
    expect(dataplaneFlightToPriceData(flight, '2026-06-15', 'USD').stops).toBe(1);
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

  // The NL q= fallback puts NO passenger count in the phrase, so Google prices a
  // single adult. It is therefore only a FAITHFUL fallback for a solo-adult
  // query; anything else must suppress it (see the suppression tests below).
  const soloQuery: TfsQuery = {
    ...tfsQuery,
    passengers: { adults: 1, children: 0, infantsInSeat: 0, infantsOnLap: 0 },
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

  it('REFUSES the legacy q= fallback for a multi-passenger party (it would price ONE ADULT)', async () => {
    // Live-caught by the ticket-tracker-njl e2e: a 3-adult + 2-child LAX->AKL
    // round trip fell back to the q= path, whose phrase carries NO passenger
    // count, so Google priced a single adult and $845 was reported as the FAMILY
    // total. Suppress the fallback rather than return a wrong-party price.
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'https://tfs.example', resultsFound: false, source: 'google_flights' });
    mockNavigateGoogleFlights.mockResolvedValue({ html: '<html>legacy</html>', url: 'https://legacy.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [SAMPLE_PRICE], usage: { inputTokens: 10, outputTokens: 5 } });

    const adapter = createFetchBrowserAdapter({
      pairParams: PAIR_PARAMS, filters: FILTERS, countryProfile: undefined, proxyUrl: undefined, travelDateFallback: '2026-12-18',
    });
    const result = await adapter.fetchBrowser(tfsQuery); // 3 adults + 2 children

    expect(mockNavigateGoogleFlights).not.toHaveBeenCalled();
    expect(mockExtractPrices).not.toHaveBeenCalled();
    // Empty (not error) so the orchestrator's canary decides no_options vs throttled.
    expect(result).toEqual({ status: 'ok', flights: [] });
    expect(adapter.getPrices()).toEqual([]);
  });

  it('REFUSES the legacy q= fallback for an open-jaw itinerary (it would reprice a mirrored round trip)', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'https://tfs.example', resultsFound: false, source: 'google_flights' });
    mockNavigateGoogleFlights.mockResolvedValue({ html: '<html>legacy</html>', url: 'https://legacy.example', resultsFound: true, source: 'google_flights' });

    const adapter = createFetchBrowserAdapter({
      pairParams: PAIR_PARAMS, filters: FILTERS, countryProfile: undefined, proxyUrl: undefined, travelDateFallback: '2026-12-18',
    });
    const result = await adapter.fetchBrowser({
      ...soloQuery, // solo adult, so ONLY the route shape can trigger suppression
      trip: 'open-jaw',
      segments: [
        { date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' },
        { date: '2027-01-08', fromAirport: 'CHC', toAirport: 'LAX' },
      ],
    });

    expect(mockNavigateGoogleFlights).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'ok', flights: [] });
  });

  it('falls back to the legacy q= path when tfs navigation finds no results', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'https://tfs.example', resultsFound: false, source: 'google_flights' });
    mockNavigateGoogleFlights.mockResolvedValue({ html: '<html>legacy</html>', url: 'https://legacy.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [SAMPLE_PRICE], usage: { inputTokens: 10, outputTokens: 5 } });

    const adapter = createFetchBrowserAdapter({
      pairParams: PAIR_PARAMS, filters: FILTERS, countryProfile: undefined, proxyUrl: undefined, travelDateFallback: '2026-12-18',
    });
    await adapter.fetchBrowser(soloQuery);

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
    const result = await adapter.fetchBrowser(soloQuery);

    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
  });

  it('propagates an exception thrown by the legacy fallback path unchanged (preserves the existing aggregator-chain error-surfacing contract)', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'https://tfs.example', resultsFound: false, source: 'google_flights' });
    mockNavigateGoogleFlights.mockRejectedValue(new Error('browser crashed'));

    const adapter = createFetchBrowserAdapter({
      pairParams: PAIR_PARAMS, filters: FILTERS, countryProfile: undefined, proxyUrl: undefined, travelDateFallback: '2026-12-18',
    });

    await expect(adapter.fetchBrowser(soloQuery)).rejects.toThrow('browser crashed');
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
    // The family's ONLY faithful browser path is the tfs URL (the q= fallback is
    // suppressed for a multi-passenger party), so drive the empty-browser case
    // through tfs succeeding with a page that yields zero flights.
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '<html>no flights</html>', url: 'https://tfs.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [], usage: { inputTokens: 10, outputTokens: 5 } });
    // Canary (adults-only SSR) sees real inventory — the "healthy connection, genuinely sold out" case.
    mockFetchSsr.mockResolvedValue({ status: 'ok', flights: [{ price: 6448, airlines: ['American'], legs: [] }] });

    const result = await runTwoTierGoogleFlights(baseDeps);

    expect(result.availability).toBe('no_options');
    expect(result.prices).toEqual([]);
    expect(result.canaryOk).toBe(true);
  });

  it('negative control: empty browser + canary ALSO empty => throttled, NOT no_options, zero prices', async () => {
    // The family's ONLY faithful browser path is the tfs URL (the q= fallback is
    // suppressed for a multi-passenger party), so drive the empty-browser case
    // through tfs succeeding with a page that yields zero flights.
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '<html>no flights</html>', url: 'https://tfs.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [], usage: { inputTokens: 10, outputTokens: 5 } });
    // Canary (adults-only SSR) is ALSO empty — the soft-blocked/throttled case.
    mockFetchSsr.mockResolvedValue({ status: 'ok', flights: [] });

    const result = await runTwoTierGoogleFlights(baseDeps);

    expect(result.availability).toBe('throttled');
    expect(result.prices).toEqual([]);
    expect(result.canaryOk).toBe(false);
  });

  it('a SUPPRESSED family query is NEVER recorded as no_options — we declined to look, so we made no market determination', async () => {
    // The trap (live-caught in ticket-tracker-njl): the family's q= fallback is
    // suppressed, so the browser returns empty. The canary then finds adults-only
    // inventory and the orchestrator would conclude "the family trip is SOLD OUT"
    // — for a trip it never actually checked. That poisons the availability
    // history and can later fire a bogus no_options -> available alert.
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'https://tfs.example', resultsFound: false, source: 'google_flights' });
    mockNavigateGoogleFlights.mockResolvedValue({ html: '<html>legacy</html>', url: 'https://legacy.example', resultsFound: true, source: 'google_flights' });
    // Canary DOES see inventory — this is precisely what would force no_options.
    mockFetchSsr.mockResolvedValue({ status: 'ok', flights: [{ price: 6448, airlines: ['American'], legs: [] }] });

    const result = await runTwoTierGoogleFlights(baseDeps); // 3 adults + 2 children

    expect(mockNavigateGoogleFlights).not.toHaveBeenCalled();
    expect(result.failureReason).toBe('unsupported_query');
    // undefined = "no market determination made" (NOT no_options, NOT available).
    expect(result.availability).toBeUndefined();
    expect(result.prices).toEqual([]);
  });

  it('available path: browser finds real flights => availability available, real PriceData preserved, canary never consulted', async () => {
    // baseDeps is the 5-person family. Its ONLY faithful browser path is the tfs
    // URL (which encodes the party); the passenger-less q= fallback is suppressed,
    // so this test drives the tfs path succeeding.
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '<html>flights</html>', url: 'https://tfs.example', resultsFound: true, source: 'google_flights' });
    mockExtractPrices.mockResolvedValue({ prices: [SAMPLE_PRICE], usage: { inputTokens: 10, outputTokens: 5 } });

    const result = await runTwoTierGoogleFlights(baseDeps);

    expect(result.availability).toBe('available');
    expect(result.prices).toEqual([SAMPLE_PRICE]);
    expect(result.canaryOk).toBeNull();
    expect(mockFetchSsr).not.toHaveBeenCalled();
  });

  it('SSR-tier success path (adults-only, no children) persists real prices from the SSR result, WITHOUT ever touching the browser', async () => {
    // Regression control: orchestrateScrape's SSR-success branch returns its
    // flights on the RESULT itself (never calling fetchBrowser at all), not
    // via the browser adapter's capture. A naive wrapper that only reads
    // browserAdapter.getPrices() would silently persist ZERO snapshots for
    // every successful SSR-tier hit -- exactly the fast, no-browser-needed
    // case the two-tier design exists to serve efficiently.
    const adultsOnlyDeps = { ...baseDeps, passengers: { adults: 3, children: 0, infantsInSeat: 0, infantsOnLap: 0 } };
    const ssrFlight: DataplaneFlight = {
      price: 6448,
      airlines: ['American'],
      legs: [{
        fromAirport: 'LAX', fromAirportName: 'Los Angeles', toAirport: 'AKL', toAirportName: 'Auckland',
        departureDate: [2026, 12, 18], departureTime: [13, 0], arrivalDate: [2026, 12, 19], arrivalTime: [7, 30],
        duration: 800, planeType: '787',
      }],
    };
    mockFetchSsr.mockResolvedValue({ status: 'ok', flights: [ssrFlight] });

    const result = await runTwoTierGoogleFlights(adultsOnlyDeps);

    expect(result.availability).toBe('available');
    expect(result.tier).toBe('ssr');
    expect(result.prices).toEqual([dataplaneFlightToPriceData(ssrFlight, '2026-12-18', 'USD')]);
    expect(result.prices.length).toBeGreaterThan(0);
    expect(mockNavigateGoogleFlightsUrl).not.toHaveBeenCalled();
    expect(mockNavigateGoogleFlights).not.toHaveBeenCalled();
    expect(mockExtractPrices).not.toHaveBeenCalled();
  });
});
