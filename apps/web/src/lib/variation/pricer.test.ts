import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunTwoTier = vi.fn();
vi.mock('../scraper/dataplane-integration', () => ({
  runTwoTierGoogleFlights: (...args: unknown[]) => mockRunTwoTier(...args),
}));

import { createDataplanePricer, tfsQueryToSearchParams } from './pricer';
import type { TfsQuery } from '../dataplane/tfs-builder';

const PARTY = { adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 0 };

const RT: TfsQuery = {
  trip: 'round-trip',
  seat: 'economy',
  segments: [
    { date: '2026-12-13', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2027-01-03', fromAirport: 'AKL', toAirport: 'LAX' },
  ],
  passengers: PARTY,
};

const OPEN_JAW: TfsQuery = {
  trip: 'open-jaw',
  seat: 'economy',
  segments: [
    { date: '2026-12-13', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2027-01-03', fromAirport: 'CHC', toAirport: 'LAX' },
  ],
  passengers: PARTY,
};

const FILTERS = {
  maxPrice: null,
  maxStops: null,
  maxDurationHours: null,
  preferredAirlines: [],
  timePreference: 'any',
  cabinClass: 'economy',
};

function twoTierResult(over: Record<string, unknown> = {}) {
  return {
    prices: [
      { travelDate: '2026-12-13', price: 6200, currency: 'USD', airline: 'Qantas', bookingUrl: null, stops: 1, duration: null, departureTime: null, arrivalTime: null, seatsLeft: null, flightNumber: null },
      { travelDate: '2026-12-13', price: 4975, currency: 'USD', airline: 'Fiji Airways', bookingUrl: null, stops: 1, duration: null, departureTime: null, arrivalTime: null, seatsLeft: null, flightNumber: null },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    availability: 'available',
    tier: 'browser_llm',
    canaryOk: null,
    browserRequestsUsed: 1,
    ...over,
  };
}

describe('tfsQueryToSearchParams', () => {
  it('maps a round trip without inventing segments', () => {
    const p = tfsQueryToSearchParams(RT, { currency: 'USD' });
    expect(p.origin).toBe('LAX');
    expect(p.destination).toBe('AKL');
    expect(p.tripType).toBe('round_trip');
    expect(p.adults).toBe(3);
    expect(p.children).toBe(2);
    expect(p.segments).toBeUndefined(); // a simple pair needs no leg list
  });

  it('carries the ordered legs for an open jaw so it is not rebuilt as a mirrored round trip', () => {
    const p = tfsQueryToSearchParams(OPEN_JAW, { currency: 'USD' });
    expect(p.tripType).toBe('open_jaw');
    // The k5m.5 bug was reconstructing the return as AKL->LAX. It must stay CHC.
    expect(p.segments).toEqual([
      { from: 'LAX', to: 'AKL', date: '2026-12-13' },
      { from: 'CHC', to: 'LAX', date: '2027-01-03' },
    ]);
  });
});

describe('createDataplanePricer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the cheapest PARTY total and does not multiply by passenger count', async () => {
    mockRunTwoTier.mockResolvedValue(twoTierResult());
    const price = await createDataplanePricer({ filters: FILTERS, currency: 'USD' })(RT);

    // Google already priced all 5 travellers into each row — 4975 is the family
    // total. Multiplying by 5 here would silently report ~$25k.
    expect(price.total).toBe(4975);
    expect(price.currency).toBe('USD');
    expect(price.availability).toBe('available');
  });

  it('forces deepSearch so the SSR top-5 cannot hide cheaper one-stop carriers', async () => {
    mockRunTwoTier.mockResolvedValue(twoTierResult());
    await createDataplanePricer({ filters: FILTERS })(RT);
    expect(mockRunTwoTier).toHaveBeenCalledWith(
      expect.objectContaining({ deepSearch: true }),
    );
  });

  it('carries no total when the route is genuinely sold out', async () => {
    mockRunTwoTier.mockResolvedValue(twoTierResult({ prices: [], availability: 'no_options' }));
    const price = await createDataplanePricer({ filters: FILTERS })(RT);
    expect(price.total).toBeNull();
    expect(price.availability).toBe('no_options');
  });

  it('reports throttled — never no_options — when the run made no market determination', async () => {
    // availability undefined = we never actually checked the market (e.g. an LLM
    // error). Claiming "sold out" here would poison the availability history.
    mockRunTwoTier.mockResolvedValue(twoTierResult({ prices: [], availability: undefined }));
    const price = await createDataplanePricer({ filters: FILTERS })(RT);
    expect(price.availability).toBe('throttled');
    expect(price.total).toBeNull();
  });

  it('never reports a price for a run that was throttled, even if stale rows came back', async () => {
    mockRunTwoTier.mockResolvedValue(twoTierResult({ availability: 'throttled' }));
    const price = await createDataplanePricer({ filters: FILTERS })(RT);
    expect(price.total).toBeNull();
  });

  it('always charges at least one request so a sweep cannot loop for free', async () => {
    mockRunTwoTier.mockResolvedValue(twoTierResult({ browserRequestsUsed: 0 }));
    const price = await createDataplanePricer({ filters: FILTERS })(RT);
    expect(price.requestsUsed).toBeGreaterThanOrEqual(1);
  });
});
