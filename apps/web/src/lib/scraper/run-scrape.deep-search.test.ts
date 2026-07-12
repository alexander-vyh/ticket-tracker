/**
 * deepSearch tier selection for tracked queries (ticket-tracker-gvh).
 *
 * An adults-only query is served by Google's SSR tier, which returns only its
 * top-5 "best" ranked flights. That set structurally excludes the cheaper
 * one-stop carriers, so a tracker built on it reports a fare that is real but
 * not the cheapest available. `deepSearch` is the per-query opt-in that skips
 * SSR for the full-list browser tier. It is off by default because it forces an
 * LLM extraction on every scrape.
 *
 * Lives in its own file rather than run-scrape.test.ts because that file is
 * already past the complexity gate's hard limit.
 *
 * oracle: the expected fares are NOT read back from our own code — they encode a
 * property of Google's upstream endpoints established by live observation in
 * ticket-tracker-k5m.8: the SSR/default view of LAX-AKL returned 8 results with
 * no Fiji Airways at all, while expanding the browser-tier list surfaced 108
 * results including the cheaper Fiji one-stop. The two tiers therefore disagree
 * about the cheapest fare, and which fare reaches price history is the
 * user-visible consequence this suite pins down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockNavigateGoogleFlights, mockExtractPrices, mockIsKnownAirline, mockFetchSsr } = vi.hoisted(() => ({
  mockPrisma: {
    query: { findUnique: vi.fn() },
    fetchRun: { create: vi.fn(), update: vi.fn() },
    extractionConfig: { findFirst: vi.fn() },
    priceSnapshot: { createMany: vi.fn(), findMany: vi.fn() },
    apiUsageLog: { create: vi.fn() },
  },
  mockNavigateGoogleFlights: vi.fn(),
  mockExtractPrices: vi.fn(),
  mockIsKnownAirline: vi.fn(),
  mockFetchSsr: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));

vi.mock('./navigate', () => ({
  navigateGoogleFlights: (...args: unknown[]) => mockNavigateGoogleFlights(...args),
  navigateGoogleFlightsUrl: vi.fn(),
  navigateAirlineDirect: vi.fn(),
  navigateSkyscanner: vi.fn(),
  navigateKayak: vi.fn(),
}));

vi.mock('./extract-prices', () => ({
  extractPrices: (...args: unknown[]) => mockExtractPrices(...args),
}));

vi.mock('../dataplane/ssr-fetch', () => ({
  fetchSsr: (...args: unknown[]) => mockFetchSsr(...args),
}));

vi.mock('./airline-urls', () => ({
  isKnownAirline: (...args: unknown[]) => mockIsKnownAirline(...args),
  getAirlineSearchUrl: vi.fn(),
}));

import { runScrapeForQuery } from './run-scrape';

const BASE_QUERY = {
  id: 'q1',
  active: true,
  isSeed: false,
  origin: 'LAX',
  destination: 'AKL',
  dateFrom: new Date('2026-06-15'),
  dateTo: new Date('2026-06-29'),
  cabinClass: 'economy',
  tripType: 'round_trip',
  currency: null,
  preferredAirlines: [],
  preferredAggregators: [] as string[],
  maxPrice: null,
  maxStops: null,
  maxDurationHours: null,
  timePreference: 'any',
  flexibility: 0,
  lookAheadDays: 14,
  expiresAt: new Date('2027-01-01'),
  vpnCountries: [],
  user: null as { preferredAggregators: string[] } | null,
};

/** The one-stop the browser tier finds once the full carrier list is rendered. */
const FIJI_ONE_STOP = {
  travelDate: '2026-06-15',
  price: 496,
  currency: 'USD',
  airline: 'Fiji Airways',
  bookingUrl: '',
  stops: 1,
  duration: '18h 00m',
  departureTime: null,
  arrivalTime: null,
  seatsLeft: null,
  flightNumber: null,
};

/** The nonstop Google ranks into its top-5 "best" SSR set (a DataplaneFlight). */
const AIR_NZ_NONSTOP = {
  price: 845,
  airlines: ['Air New Zealand'],
  legs: [{
    fromAirport: 'LAX',
    fromAirportName: 'Los Angeles',
    toAirport: 'AKL',
    toAirportName: 'Auckland',
    departureDate: [2026, 6, 15],
    departureTime: [22, 30],
    arrivalDate: [2026, 6, 17],
    arrivalTime: [6, 15],
    duration: 780,
    planeType: null,
  }],
};

describe('runScrapeForQuery — deepSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsKnownAirline.mockReturnValue(false);
    mockPrisma.fetchRun.create.mockResolvedValue({ id: 'run1' });
    mockPrisma.fetchRun.update.mockResolvedValue({});
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'test-model',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
    });
    mockPrisma.priceSnapshot.findMany.mockResolvedValue([]);
    mockPrisma.priceSnapshot.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.apiUsageLog.create.mockResolvedValue({});
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html>full carrier list</html>',
      url: 'https://flights.google.com',
      resultsFound: true,
      source: 'google_flights',
    });
    mockExtractPrices.mockResolvedValue({
      prices: [FIJI_ONE_STOP],
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    // SSR can serve this adults-only query, and answers with its top-5 set.
    mockFetchSsr.mockResolvedValue({ status: 'ok', flights: [AIR_NZ_NONSTOP] });
  });

  /** The fares actually written to price history — what the user ends up seeing. */
  function persistedFares(): Array<{ airline: string; price: number }> {
    return mockPrisma.priceSnapshot.createMany.mock.calls
      .flatMap((call) =>
        Array.isArray(call[0]?.data) ? (call[0].data as Array<{ airline: string; price: number }>) : [],
      )
      .map((row) => ({ airline: row.airline, price: row.price }));
  }

  it('records the dearer SSR fare for an adults-only query when deepSearch is off', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({ ...BASE_QUERY, deepSearch: false });

    await runScrapeForQuery('q1');

    // SSR's "best" set carries the $845 nonstop and not the $496 one-stop, so
    // that is the fare the tracker records. This is the cheap, high-frequency
    // default — correct, but not the cheapest fare on sale.
    expect(persistedFares()).toEqual([{ airline: 'Air New Zealand', price: 845 }]);
  });

  it('records the cheaper one-stop fare that SSR hides when the query opts into deepSearch', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({ ...BASE_QUERY, deepSearch: true });

    await runScrapeForQuery('q1');

    // The whole point of the flag: the full carrier list reaches price history,
    // so the $496 Fiji one-stop is tracked instead of the $845 SSR nonstop.
    expect(persistedFares()).toEqual([{ airline: 'Fiji Airways', price: 496 }]);
  });

  it('treats a legacy query row with no deepSearch column as off', async () => {
    mockPrisma.query.findUnique.mockResolvedValue(BASE_QUERY); // no deepSearch key

    await runScrapeForQuery('q1');

    expect(persistedFares()).toEqual([{ airline: 'Air New Zealand', price: 845 }]);
  });
});
