import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindFirst = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: { extractionConfig: { findFirst: (...a: unknown[]) => mockFindFirst(...a) } },
}));

// The sweep itself is unit-tested in lib/variation; here we only care that the
// route validates input and reports coverage honestly. Stub the pricer so no
// network is touched.
const mockPricer = vi.fn();
vi.mock('@/lib/variation/pricer', () => ({
  createDataplanePricer: () => mockPricer,
}));

import { POST } from './route';

function req(body: unknown): Parameters<typeof POST>[0] {
  return { json: async () => body } as Parameters<typeof POST>[0];
}

/** A valid LAX->NZ holiday sweep. */
function validBody(over: Record<string, unknown> = {}) {
  return {
    origin: 'LAX',
    destinations: ['AKL'],
    departWindow: { from: '2026-12-13', to: '2026-12-14' },
    returnWindow: { from: '2027-01-03', to: '2027-01-04' },
    stayNights: { min: 20, max: 22 },
    shapes: ['round_trip'],
    maxCombos: 10,
    requestBudget: 10,
    adults: 3,
    children: 2,
    ...over,
  };
}

interface SweepBody {
  ok: boolean;
  error?: string;
  data?: {
    best: { total: number | null } | null;
    cells: unknown[];
    coverage: {
      complete: boolean;
      droppedByCap: number;
      skippedForBudget: number;
      requestsUsed: number;
    };
  };
}

async function post(body: unknown) {
  const res = await POST(req(body));
  return { status: res.status, json: (await res.json()) as SweepBody };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindFirst.mockResolvedValue({ defaultCurrency: 'USD', defaultCountry: null });
  mockPricer.mockResolvedValue({
    total: 4975,
    currency: 'USD',
    availability: 'available',
    requestsUsed: 1,
  });
});

describe('POST /api/variation/search — validation', () => {
  it('rejects a non-IATA origin', async () => {
    const { status, json } = await post(validBody({ origin: 'Los Angeles' }));
    expect(status).toBe(400);
    expect(json.error).toMatch(/3-letter airport code/);
  });

  it('rejects an empty gateway list', async () => {
    const { status, json } = await post(validBody({ destinations: [] }));
    expect(status).toBe(400);
    expect(json.error).toMatch(/at least one gateway/);
  });

  it('rejects an inverted date window', async () => {
    const { status, json } = await post(
      validBody({ departWindow: { from: '2026-12-20', to: '2026-12-10' } }),
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(/must not precede/);
  });

  it('rejects an unknown route shape', async () => {
    const { status, json } = await post(validBody({ shapes: ['hyperloop'] }));
    expect(status).toBe(400);
    expect(json.error).toMatch(/must be one of/);
  });

  it('rejects more lap infants than adults (an airline rule, not a preference)', async () => {
    const { status, json } = await post(validBody({ adults: 1, children: 0, infantsOnLap: 2 }));
    expect(status).toBe(400);
    expect(json.error).toMatch(/infantsOnLap must not exceed adults/);
  });

  it('rejects a party larger than 9', async () => {
    const { status, json } = await post(validBody({ adults: 9, children: 2 }));
    expect(status).toBe(400);
    expect(json.error).toMatch(/must not exceed 9/);
  });

  it('caps the request budget so one call cannot melt the browser tier', async () => {
    const { status, json } = await post(validBody({ requestBudget: 9999 }));
    expect(status).toBe(400);
    expect(json.error).toMatch(/requestBudget must be/);
  });
});

describe('POST /api/variation/search — sweep', () => {
  it('returns the cheapest bookable cell and honest coverage', async () => {
    const { status, json } = await post(validBody());
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data!.best!.total).toBe(4975);
    expect(json.data!.cells.length).toBeGreaterThan(0);
    // A complete sweep must say so — and a partial one must not pretend.
    expect(json.data!.coverage.complete).toBe(true);
    expect(json.data!.coverage.droppedByCap).toBe(0);
    expect(json.data!.coverage.skippedForBudget).toBe(0);
  });

  it('flags an INCOMPLETE sweep when the budget cuts it short', async () => {
    // 4 combos in range, but only 1 request of budget.
    const { json } = await post(validBody({ requestBudget: 1, maxCombos: 10 }));
    expect(json.data!.coverage.complete).toBe(false);
    expect(json.data!.coverage.skippedForBudget).toBeGreaterThan(0);
    // Still returns the best of what it DID price — partial but honest.
    expect(json.data!.best!.total).toBe(4975);
  });

  it('reports no best cell when every candidate is sold out', async () => {
    mockPricer.mockResolvedValue({
      total: null,
      currency: 'USD',
      availability: 'no_options',
      requestsUsed: 1,
    });
    const { json } = await post(validBody());
    expect(json.data!.best).toBeNull();
  });
});
