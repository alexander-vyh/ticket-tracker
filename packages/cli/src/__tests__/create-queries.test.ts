import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryCreate, mockSnapshotCreateMany } = vi.hoisted(() => ({
  mockQueryCreate: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'q-' + Math.random().toString(36).slice(2, 8), ...args.data })
  ),
  mockSnapshotCreateMany: vi.fn().mockResolvedValue({ count: 0 }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    query: { create: mockQueryCreate },
    priceSnapshot: { createMany: mockSnapshotCreateMany },
    // resolveOwnerId() reads the singleton config; solo mode (multiUserMode
    // false) short circuits before any user lookup, leaving trackers unowned.
    extractionConfig: { findUnique: vi.fn().mockResolvedValue({ multiUserMode: false }) },
    user: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { createTrackedQueries } from '../lib/create-queries.js';

const baseParsed = {
  origin: 'BRI',
  originName: 'Bari',
  destination: 'JFK',
  destinationName: 'New York JFK',
  origins: [{ code: 'BRI', name: 'Bari' }],
  destinations: [{ code: 'JFK', name: 'New York JFK' }],
  dateFrom: '2026-11-07',
  dateTo: '2026-11-07',
  flexibility: 0,
  tripType: 'one_way' as const,
  cabinClass: 'economy' as const,
  maxPrice: null,
  maxStops: null,
  maxDurationHours: null,
  preferredAirlines: [] as string[],
  timePreference: 'any' as const,
  currency: 'EUR',
  adults: 1,
  children: 0,
  infantsInSeat: 0,
  infantsOnLap: 0,
};

const baseRoute = {
  origin: 'BRI',
  originName: 'Bari',
  destination: 'JFK',
  destinationName: 'New York JFK',
  date: '2026-11-07',
  flights: [],
};

describe('createTrackedQueries', () => {
  beforeEach(() => {
    mockQueryCreate.mockClear();
    mockSnapshotCreateMany.mockClear();
  });

  it('persists the exact parsed passenger tuple for family trackers', async () => {
    await createTrackedQueries(
      {
        ...baseParsed,
        adults: 2,
        children: 1,
        infantsInSeat: 1,
        infantsOnLap: 1,
      },
      'Two adults, one child, and two infants from BRI to JFK Nov 7',
      [{ route: { ...baseRoute }, flights: [] }],
    );

    const createCall = mockQueryCreate.mock.calls[0]![0] as {
      data: {
        adults: number;
        children: number;
        infantsInSeat: number;
        infantsOnLap: number;
      };
    };
    expect({
      adults: createCall.data.adults,
      children: createCall.data.children,
      infantsInSeat: createCall.data.infantsInSeat,
      infantsOnLap: createCall.data.infantsOnLap,
    }).toEqual({ adults: 2, children: 1, infantsInSeat: 1, infantsOnLap: 1 });
  });

  it('persists an asymmetric passenger tuple for every selected route', async () => {
    await createTrackedQueries(
      {
        ...baseParsed,
        adults: 3,
        children: 2,
        infantsInSeat: 0,
        infantsOnLap: 1,
      },
      'Three adults, two children, and one lap infant from BRI to New York Nov 7',
      [
        { route: { ...baseRoute }, flights: [] },
        {
          route: {
            ...baseRoute,
            destination: 'EWR',
            destinationName: 'Newark',
          },
          flights: [],
        },
      ],
    );

    expect(mockQueryCreate).toHaveBeenCalledTimes(2);
    for (const [call] of mockQueryCreate.mock.calls) {
      const data = (call as { data: Record<string, unknown> }).data;
      expect({
        adults: data.adults,
        children: data.children,
        infantsInSeat: data.infantsInSeat,
        infantsOnLap: data.infantsOnLap,
      }).toEqual({ adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 1 });
    }
  });

  // Issue 65: a picked Turkish flight used to silently flag the saved query as
  // preferredAirlines=['Turkish'], routing cron through a broken
  // turkishairlines.com URL forever.
  it('does NOT auto-derive preferredAirlines from selected flights', async () => {
    await createTrackedQueries(
      { ...baseParsed, preferredAirlines: [] },
      'BRI to JFK Nov 7',
      [{
        route: { ...baseRoute, flights: [] },
        flights: [
          { travelDate: '2026-11-07', price: 431, currency: 'EUR', airline: 'Turkish Airlines', bookingUrl: 'https://turkishairlines.com', stops: 1, duration: '12h 30m', departureTime: '10:25 AM', arrivalTime: '4:45 PM', seatsLeft: null, flightNumber: 'TK 1' },
        ],
      }],
    );
    const createCall = mockQueryCreate.mock.calls[0]![0] as { data: { preferredAirlines: string[] } };
    expect(createCall.data.preferredAirlines).toEqual([]);
  });

  it('preserves explicit preferredAirlines even when selected flights contain other airlines', async () => {
    await createTrackedQueries(
      { ...baseParsed, preferredAirlines: ['Lufthansa'] },
      'Lufthansa flights BRI to JFK Nov 7',
      [{
        route: { ...baseRoute, flights: [] },
        flights: [
          { travelDate: '2026-11-07', price: 431, currency: 'EUR', airline: 'Turkish Airlines', bookingUrl: 'https://turkishairlines.com', stops: 1, duration: '12h 30m', departureTime: '10:25 AM', arrivalTime: '4:45 PM', seatsLeft: null, flightNumber: 'TK 1' },
        ],
      }],
    );
    const createCall = mockQueryCreate.mock.calls[0]![0] as { data: { preferredAirlines: string[] } };
    expect(createCall.data.preferredAirlines).toEqual(['Lufthansa']);
  });
});
