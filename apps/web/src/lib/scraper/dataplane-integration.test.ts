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
  priceDataToDataplaneFlight,
  dataplaneFlightToPriceData,
  createFetchBrowserAdapter,
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

// adultsOnlyVariant() is DELETED and its tests with it. It built the canary by
// stripping children off the real query, so a 3a+2c family was vouched for by a
// 3-ADULT probe — which passes Google's >=4 party gate all night and certified
// every fabricated 5-pax zero as a genuine sold-out. The canary now runs at the
// query's own party size through the browser tier (see ./canary.test.ts and
// ../dataplane/no-options-guard.test.ts). (ticket-tracker-45a)

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

  // Every browser-tier request — the target fetch, the party-matched canary, and
  // the monotonicity probe — goes through navigateGoogleFlightsUrl, in that
  // order. Sequencing them is what lets these tests drive each guard branch.
  const RESULTS = { html: '<html>flights</html>', url: 'https://tfs.example', resultsFound: true, source: 'google_flights' };
  const NO_OPTIONS = { html: '<html>no flights</html>', url: 'https://tfs.example', resultsFound: false, noOptions: true, source: 'google_flights' };
  function navSequence(...results: unknown[]): void {
    for (const r of results) mockNavigateGoogleFlightsUrl.mockResolvedValueOnce(r);
  }

  it('positive control: empty browser + party-matched canary with inventory + clean monotonicity => no_options', async () => {
    // The family's ONLY faithful browser path is the tfs URL (the q= fallback is
    // suppressed for a multi-passenger party), so drive the empty-browser case
    // through tfs succeeding with a page that yields zero flights.
    // Order: target fetch (renders, but zero extractable prices) -> canary (5-pax
    // reference cell RENDERS => channel healthy at 5 pax) -> monotonicity probe
    // (1 adult finds nothing on the target cell either => nobody beats the family).
    navSequence(RESULTS, RESULTS, NO_OPTIONS);
    mockExtractPrices.mockResolvedValue({ prices: [], usage: { inputTokens: 10, outputTokens: 5 } });

    const result = await runTwoTierGoogleFlights(baseDeps);

    expect(result.availability).toBe('no_options');
    expect(result.prices).toEqual([]);
    expect(result.canaryOk).toBe(true);
  });

  it('negative control: empty browser + an EMPTY party-matched canary => throttled, NOT no_options', async () => {
    // The soft-blocked / party-gated case: the known-good reference cell is ALSO
    // empty at 5 passengers, so we cannot tell a sold-out from a lie.
    navSequence(RESULTS, NO_OPTIONS);
    mockExtractPrices.mockResolvedValue({ prices: [], usage: { inputTokens: 10, outputTokens: 5 } });

    const result = await runTwoTierGoogleFlights(baseDeps);

    expect(result.availability).toBe('throttled');
    expect(result.prices).toEqual([]);
    expect(result.canaryOk).toBe(false);
  });

  it('MONOTONICITY: a 5-pax empty that a 1-adult probe beats on the same cell is never no_options, even with a green canary', async () => {
    // The fabricated >=4 gate, end to end. Target empty at 5 pax; the reference
    // cell happens to render at 5 pax (canary green); but a 1-adult probe on the
    // TARGET's own cell finds flights. Availability cannot grow with the party, so
    // the 5-pax zero is not a sold-out and must not be recorded as one.
    navSequence(RESULTS, RESULTS, RESULTS);
    mockExtractPrices.mockResolvedValue({ prices: [], usage: { inputTokens: 10, outputTokens: 5 } });

    const result = await runTwoTierGoogleFlights(baseDeps);

    expect(result.availability).toBe('throttled');
    expect(result.availability).not.toBe('no_options');
    expect(result.prices).toEqual([]);
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

  // The mirror image of the suppression test above, and the ticket-tracker-zfj
  // root cause. Live-verified 2026-07-11: for 3 adults + 2 children on
  // LAX->AKL 2026-12-08/2026-12-31, Google itself renders "No options matching
  // your search" — in the container AND in a real desktop browser on a
  // residential IP — while 5 adults on the same dates prices at $4,120 and the
  // same family prices at $3,725 on adjacent dates. That is an ANSWER, not a
  // block. Reporting it as `unsupported_query` ("we declined to look") was a
  // false statement about a query we did check, and it left the family trip
  // permanently unpriceable AND unmarkable as sold out.
  const GOOGLE_NO_OPTIONS_TEXT =
    'Flight search Round trip 5 Economy Los Angeles LAX Auckland AKL Filters ' +
    'Search results No results returned. No options matching your search ' +
    'Try changing your dates or destination to see results';

  const GOOGLE_ANSWERED_NO_OPTIONS = {
    html: GOOGLE_NO_OPTIONS_TEXT,
    url: 'https://tfs.example',
    resultsFound: false,
    noOptions: true,
    source: 'google_flights',
  };

  it('a family query Google ANSWERED with no-options is no_options (canary-confirmed) — not unsupported_query', async () => {
    // Target: Google's explicit empty-results page. Canary: the reference cell
    // RENDERS at the same 5-passenger party => the channel is answering 5-pax
    // queries truthfully right now. Monotonicity: 1 adult finds nothing on the
    // target cell either => the cell really is empty, for everyone.
    navSequence(GOOGLE_ANSWERED_NO_OPTIONS, RESULTS, GOOGLE_ANSWERED_NO_OPTIONS);

    const result = await runTwoTierGoogleFlights(baseDeps); // 3 adults + 2 children

    expect(result.availability).toBe('no_options');
    // NOT a failure: we looked and Google answered. A non-market failure reason
    // here would suppress the availability determination entirely.
    expect(result.failureReason).toBeUndefined();
    expect(result.prices).toEqual([]);
    expect(result.canaryOk).toBe(true);
    // The passenger-less q= fallback must STILL never run for a family query.
    expect(mockNavigateGoogleFlights).not.toHaveBeenCalled();
    // No LLM extraction on an empty page — there is nothing to extract.
    expect(mockExtractPrices).not.toHaveBeenCalled();
  });

  it('THE P0 BUG: Google\'s no-options page for a 5-pax family, with the reference cell ALSO gated at 5 pax, is throttled — never no_options', async () => {
    // This is the exact shape of the 17 fabricated "sold out" cells. Google
    // renders a literal, realistic "No options matching your search" for the
    // family — correct dates, correct "5 passengers" header, realistic delay —
    // and it is a LIE. The party-matched canary is what catches it: the
    // known-good reference cell, queried at the SAME 5 passengers, comes back
    // empty too. The channel is gated, so no sold-out claim may be made.
    //
    // Note what would have happened with the OLD canary: it would have asked
    // about 3 ADULTS, sailed through the >=4 gate, returned inventory, and
    // certified this fabricated zero as a genuine sold-out.
    navSequence(GOOGLE_ANSWERED_NO_OPTIONS, GOOGLE_ANSWERED_NO_OPTIONS);

    const result = await runTwoTierGoogleFlights(baseDeps);

    expect(result.availability).toBe('throttled');
    expect(result.availability).not.toBe('no_options');
    expect(result.prices).toEqual([]);
    expect(result.canaryOk).toBe(false);
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
