import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindFirst = vi.fn();
const mockAggregate = vi.fn();
const mockFetchRunFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    priceSnapshot: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      aggregate: (...args: unknown[]) => mockAggregate(...args),
    },
    fetchRun: {
      findMany: (...args: unknown[]) => mockFetchRunFindMany(...args),
    },
  },
}));

import { detectNewLow, detectAvailabilityFlip } from './detect';

const CYCLE_START = new Date('2026-06-04T00:00:00Z');
const TRAVEL = new Date('2026-08-01T00:00:00Z');

/** Stub the cheapest current fare + the prior historical minimum. */
function arrange(opts: {
  current: { price: number; airline?: string; bookingUrl?: string | null; flightNumber?: string | null } | null;
  priorMin: number | null;
}) {
  mockFindFirst.mockResolvedValue(
    opts.current
      ? {
          price: opts.current.price,
          airline: opts.current.airline ?? 'Delta',
          bookingUrl: opts.current.bookingUrl ?? 'https://book.example/x',
          travelDate: TRAVEL,
          currency: 'USD',
          flightNumber: opts.current.flightNumber ?? 'DL 100',
        }
      : null,
  );
  mockAggregate.mockResolvedValue({ _min: { price: opts.priorMin } });
}

function run(over: Partial<Parameters<typeof detectNewLow>[0]> = {}) {
  return detectNewLow({
    query: { id: 'q1', currency: 'USD', lastNotifiedLowPrice: null },
    cycleStartedAt: CYCLE_START,
    floorAbs: 5,
    floorPct: 0,
    ...over,
  });
}

describe('detectNewLow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fires when the cheapest fare beats the prior best by more than the floor', async () => {
    arrange({ current: { price: 250, airline: 'United', bookingUrl: 'https://u/1' }, priorMin: 300 });
    const alert = await run();
    expect(alert).not.toBeNull();
    expect(alert).toMatchObject({
      queryId: 'q1',
      currentMin: 250,
      baseline: 300,
      drop: 50,
      airline: 'United',
      bookingUrl: 'https://u/1',
      currency: 'USD',
    });
  });

  it('stays silent when the new price is not below the baseline', async () => {
    arrange({ current: { price: 320 }, priorMin: 300 });
    expect(await run()).toBeNull();
  });

  it('stays silent when the drop is under the absolute floor', async () => {
    arrange({ current: { price: 297 }, priorMin: 300 }); // drop 3 < floor 5
    expect(await run()).toBeNull();
  });

  it('honours the percentage gate when configured', async () => {
    arrange({ current: { price: 96 }, priorMin: 100 }); // drop 4 = 4% < 10%
    expect(await run({ floorAbs: 1, floorPct: 0.1 })).toBeNull();

    arrange({ current: { price: 88 }, priorMin: 100 }); // drop 12 = 12% >= 10%
    const alert = await run({ floorAbs: 1, floorPct: 0.1 });
    expect(alert?.drop).toBe(12);
  });

  it('dedupes against the last alerted low, not just history', async () => {
    // Prior history bottoms at 300, but we already alerted at 250.
    arrange({ current: { price: 248 }, priorMin: 300 }); // beats history but only $2 under last alert
    expect(await run({ query: { id: 'q1', currency: 'USD', lastNotifiedLowPrice: 250 } })).toBeNull();

    arrange({ current: { price: 240 }, priorMin: 300 }); // $10 under last alert
    const alert = await run({ query: { id: 'q1', currency: 'USD', lastNotifiedLowPrice: 250 } });
    expect(alert).toMatchObject({ currentMin: 240, baseline: 250, drop: 10 });
  });

  it('establishes a baseline silently on the first scrape (no prior, no prior alert)', async () => {
    arrange({ current: { price: 199 }, priorMin: null });
    expect(await run()).toBeNull();
  });

  it('returns null when no available fares were found this cycle', async () => {
    arrange({ current: null, priorMin: 300 });
    expect(await run()).toBeNull();
  });

  it('scopes both comparisons to the query currency when it is set', async () => {
    arrange({ current: { price: 250 }, priorMin: 300 });
    await run({ query: { id: 'q1', currency: 'EUR', lastNotifiedLowPrice: null } });
    const cheapestWhere = (mockFindFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    const priorWhere = (mockAggregate.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(cheapestWhere.currency).toBe('EUR');
    expect(priorWhere.currency).toBe('EUR');
  });

  it('does not filter the current-cycle query by currency when the query currency is null', async () => {
    arrange({ current: { price: 250 }, priorMin: 300 });
    await run({ query: { id: 'q1', currency: null, lastNotifiedLowPrice: null } });
    const cheapestWhere = (mockFindFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(cheapestWhere.currency).toBeUndefined();
  });

  it('scopes the prior baseline to the cheapest fare currency when the query currency is null', async () => {
    // The arrange helper stamps the cheapest snapshot currency as USD.
    arrange({ current: { price: 250 }, priorMin: 300 });
    await run({ query: { id: 'q1', currency: null, lastNotifiedLowPrice: null } });
    const priorWhere = (mockAggregate.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(priorWhere.currency).toBe('USD');
  });

  it('falls back to the query currency when the snapshot has none', async () => {
    mockFindFirst.mockResolvedValue({
      price: 250,
      airline: 'Iberia',
      bookingUrl: null,
      travelDate: TRAVEL,
      currency: null,
      flightNumber: null,
    });
    mockAggregate.mockResolvedValue({ _min: { price: 300 } });
    const alert = await run({ query: { id: 'q1', currency: 'EUR', lastNotifiedLowPrice: null } });
    expect(alert?.currency).toBe('EUR');
  });
});

describe('detectAvailabilityFlip', () => {
  beforeEach(() => vi.clearAllMocks());

  const AFTER = new Date('2026-06-04T02:00:00Z'); // >= CYCLE_START (this cycle)
  const BEFORE = new Date('2026-06-03T02:00:00Z'); // < CYCLE_START (a prior cycle)

  /** Stub the two most-recent availability-bearing runs (newest first) plus the
   *  cheapest available fare this cycle. */
  function arrangeRuns(runs: Array<{ availability: string; startedAt: Date }>) {
    mockFetchRunFindMany.mockResolvedValue(runs);
    mockFindFirst.mockResolvedValue({
      price: 512,
      airline: 'Fiji Airways',
      bookingUrl: 'https://book.example/fj',
      travelDate: TRAVEL,
      currency: 'USD',
      flightNumber: 'FJ 810',
    });
  }
  const flip = () =>
    detectAvailabilityFlip({ query: { id: 'q1', currency: 'USD' }, cycleStartedAt: CYCLE_START });

  it('fires exactly once on a no_options -> available flip (positive control)', async () => {
    arrangeRuns([
      { availability: 'available', startedAt: AFTER }, // current, this cycle
      { availability: 'no_options', startedAt: BEFORE }, // previous, prior cycle
    ]);
    const alert = await flip();
    expect(alert).not.toBeNull();
    expect(alert).toMatchObject({ queryId: 'q1', currentMin: 512, airline: 'Fiji Airways' });
  });

  it('stays silent on two consecutive no_options runs (negative control)', async () => {
    arrangeRuns([
      { availability: 'no_options', startedAt: AFTER },
      { availability: 'no_options', startedAt: BEFORE },
    ]);
    expect(await flip()).toBeNull();
  });

  it('stays silent when already available last cycle (available -> available)', async () => {
    arrangeRuns([
      { availability: 'available', startedAt: AFTER },
      { availability: 'available', startedAt: BEFORE },
    ]);
    expect(await flip()).toBeNull();
  });

  it('needs two determinations — a single run never flips', async () => {
    arrangeRuns([{ availability: 'available', startedAt: AFTER }]);
    expect(await flip()).toBeNull();
  });

  it('ignores a same-cycle cross-sibling difference (both runs from this cycle)', async () => {
    const AFTER2 = new Date('2026-06-04T03:00:00Z');
    arrangeRuns([
      { availability: 'available', startedAt: AFTER2 },
      { availability: 'no_options', startedAt: AFTER }, // also this cycle -> not temporal
    ]);
    expect(await flip()).toBeNull();
  });

  it('does not re-alert a stale flip when this cycle produced no fresh determination', async () => {
    arrangeRuns([
      { availability: 'available', startedAt: BEFORE }, // newest run predates this cycle
      { availability: 'no_options', startedAt: new Date('2026-06-02T00:00:00Z') },
    ]);
    expect(await flip()).toBeNull();
  });

  it('reports the flip even if no fare was priced yet this cycle', async () => {
    mockFetchRunFindMany.mockResolvedValue([
      { availability: 'available', startedAt: AFTER },
      { availability: 'no_options', startedAt: BEFORE },
    ]);
    mockFindFirst.mockResolvedValue(null); // snapshots still landing
    const alert = await flip();
    expect(alert).not.toBeNull();
    expect(alert?.currentMin).toBeNull();
  });
});
