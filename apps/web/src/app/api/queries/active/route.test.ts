import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: { query: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

const mockIsMultiUserEnabled = vi.fn().mockResolvedValue(false);
const mockGetCurrentUser = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/multi-user', () => ({ isMultiUserEnabled: () => mockIsMultiUserEnabled() }));
vi.mock('@/lib/user-auth', () => ({ getCurrentUser: () => mockGetCurrentUser() }));

import { GET } from './route';

function shapedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    active: true,
    origin: 'JFK',
    destination: 'LAX',
    originName: 'New York',
    destinationName: 'Los Angeles',
    dateFrom: new Date('2026-06-10'),
    dateTo: new Date('2026-06-17'),
    scrapeInterval: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    expiresAt: new Date('2026-08-01T00:00:00Z'),
    groupId: null,
    label: null,
    preferredAggregators: [],
    fetchRuns: [],
    _count: { snapshots: 0 },
    adults: 1,
    children: 0,
    infantsInSeat: 0,
    infantsOnLap: 0,
    ...overrides,
  };
}

describe('GET /api/queries/active', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
  });

  it('surfaces lastScrapeStatus and lastScrapeError on success', async () => {
    mockFindMany.mockResolvedValue([
      shapedRow({
        fetchRuns: [
          {
            startedAt: new Date('2026-05-20T12:00:00Z'),
            status: 'success',
            error: null,
          },
        ],
      }),
    ]);
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.queries[0]).toMatchObject({
      lastScrapeStatus: 'success',
      lastScrapeError: null,
    });
  });

  it('surfaces lastScrapeStatus=failed plus the error message', async () => {
    mockFindMany.mockResolvedValue([
      shapedRow({
        fetchRuns: [
          {
            startedAt: new Date('2026-05-20T12:00:00Z'),
            status: 'failed',
            error: 'LLM response contained no parseable JSON array.',
          },
        ],
      }),
    ]);
    const res = await GET();
    const data = await res.json();
    expect(data.data.queries[0]).toMatchObject({
      lastScrapeStatus: 'failed',
      lastScrapeError: 'LLM response contained no parseable JSON array.',
    });
  });

  it('returns null status/error when the query has no fetchRuns yet', async () => {
    mockFindMany.mockResolvedValue([shapedRow({ fetchRuns: [] })]);
    const res = await GET();
    const data = await res.json();
    expect(data.data.queries[0]).toMatchObject({
      lastScrapeStatus: null,
      lastScrapeError: null,
      lastScrapedAt: null,
    });
  });

  // ticket-tracker-r06: the tracker list needs passenger counts to render a
  // compact summary on multi-pax cards.
  it('surfaces adults/children/infantsInSeat/infantsOnLap for a multi-pax tracker', async () => {
    mockFindMany.mockResolvedValue([
      shapedRow({ adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 0 }),
    ]);
    const res = await GET();
    const data = await res.json();
    // Negative control: children must surface as children, not folded into adults.
    expect(data.data.queries[0]).toMatchObject({
      adults: 3,
      children: 2,
      infantsInSeat: 0,
      infantsOnLap: 0,
    });
  });

  it('defaults passenger fields to the single-adult shape when absent from the row', async () => {
    mockFindMany.mockResolvedValue([shapedRow()]);
    const res = await GET();
    const data = await res.json();
    expect(data.data.queries[0]).toMatchObject({
      adults: 1,
      children: 0,
      infantsInSeat: 0,
      infantsOnLap: 0,
    });
  });
});
