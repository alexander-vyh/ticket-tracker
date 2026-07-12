import { describe, it, expect, vi } from 'vitest';
import { candidateToTfsQueries, runVariationSearch, type QueryPrice, type PriceQuery } from './search';
import type { Candidate, VariationSpec } from './grid';
import type { TfsQuery } from '../dataplane/tfs-builder';

const PARTY = { adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 0 };

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c1',
    shape: 'round_trip',
    outbound: { from: 'LAX', to: 'AKL', date: '2026-12-13' },
    inbound: { from: 'AKL', to: 'LAX', date: '2027-01-03' },
    stayNights: 21,
    ...over,
  };
}

function spec(over: Partial<VariationSpec> = {}): VariationSpec {
  return {
    origin: 'LAX',
    destinations: ['AKL'],
    departWindow: { from: '2026-12-13', to: '2026-12-14' },
    returnWindow: { from: '2027-01-03', to: '2027-01-04' },
    stayNights: { min: 20, max: 22 },
    shapes: ['round_trip'],
    maxCombos: 100,
    ...over,
  };
}

/** A pricer that returns a fixed price for every query. */
function pricerReturning(price: number | null, availability: QueryPrice['availability'] = 'available'): PriceQuery {
  return vi.fn(async () => ({
    total: price,
    currency: 'USD',
    availability,
    requestsUsed: 1,
  }));
}

describe('candidateToTfsQueries — the shape decides the query', () => {
  it('prices a round trip as ONE round-trip query, never two summed one-ways', () => {
    const qs = candidateToTfsQueries(candidate(), PARTY);
    expect(qs).toHaveLength(1);
    expect(qs[0]!.trip).toBe('round-trip');
    expect(qs[0]!.segments).toEqual([
      { date: '2026-12-13', fromAirport: 'LAX', toAirport: 'AKL' },
      { date: '2027-01-03', fromAirport: 'AKL', toAirport: 'LAX' },
    ]);
    expect(qs[0]!.passengers).toEqual(PARTY);
  });

  it('prices an open jaw as ONE multi-city query with a non-reversing return', () => {
    const qs = candidateToTfsQueries(
      candidate({
        shape: 'open_jaw',
        inbound: { from: 'CHC', to: 'LAX', date: '2027-01-03' },
      }),
      PARTY,
    );
    expect(qs).toHaveLength(1);
    expect(qs[0]!.trip).toBe('open-jaw');
    expect(qs[0]!.segments[1]!.fromAirport).toBe('CHC'); // home from a different city
  });

  it('prices two_one_ways as TWO separate one-way queries', () => {
    const qs = candidateToTfsQueries(candidate({ shape: 'two_one_ways' }), PARTY);
    expect(qs).toHaveLength(2);
    expect(qs.map((q) => q.trip)).toEqual(['one-way', 'one-way']);
    expect(qs[0]!.segments).toHaveLength(1);
    expect(qs[1]!.segments[0]!.fromAirport).toBe('AKL');
  });
});

describe('runVariationSearch — pricing and the best cell', () => {
  it('prices every candidate and picks the cheapest AVAILABLE one', async () => {
    // Price by departure date so we know which cell must win.
    const priceQuery: PriceQuery = vi.fn(async (q: TfsQuery) => ({
      total: q.segments[0]!.date === '2026-12-14' ? 4000 : 6000,
      currency: 'USD',
      availability: 'available' as const,
      requestsUsed: 1,
    }));

    const res = await runVariationSearch(spec(), PARTY, priceQuery, { requestBudget: 50 });

    expect(res.cells.length).toBeGreaterThan(1);
    expect(res.best).not.toBeNull();
    expect(res.best!.total).toBe(4000);
    expect(res.best!.candidate.outbound.date).toBe('2026-12-14');
  });

  it('returns no best cell when nothing is bookable', async () => {
    const res = await runVariationSearch(spec(), PARTY, pricerReturning(null, 'no_options'), {
      requestBudget: 50,
    });
    expect(res.best).toBeNull();
    expect(res.cells.every((c) => c.total === null)).toBe(true);
    expect(res.cells.every((c) => c.availability === 'no_options')).toBe(true);
  });

  it('sums both legs of a two_one_ways itinerary', async () => {
    const res = await runVariationSearch(
      spec({ shapes: ['two_one_ways'] }),
      PARTY,
      pricerReturning(2000),
      { requestBudget: 50 },
    );
    // Two legs at 2000 each -> 4000 total, and both legs recorded.
    expect(res.best!.total).toBe(4000);
    expect(res.best!.legs).toHaveLength(2);
  });

  it('refuses to price a two_one_ways trip when only ONE leg is bookable', async () => {
    // Outbound prices, return is sold out — that is not a bookable trip.
    let call = 0;
    const priceQuery: PriceQuery = vi.fn(async () => {
      call += 1;
      return call % 2 === 1
        ? { total: 2000, currency: 'USD', availability: 'available' as const, requestsUsed: 1 }
        : { total: null, currency: 'USD', availability: 'no_options' as const, requestsUsed: 1 };
    });

    const res = await runVariationSearch(spec({ shapes: ['two_one_ways'] }), PARTY, priceQuery, {
      requestBudget: 50,
    });

    // A half-priced trip must never masquerade as a cheap one.
    expect(res.best).toBeNull();
    for (const c of res.cells) {
      expect(c.total).toBeNull();
      expect(c.availability).toBe('no_options');
    }
  });

  it('reports throttled (not no_options) when a leg was soft-blocked', async () => {
    const res = await runVariationSearch(spec(), PARTY, pricerReturning(null, 'throttled'), {
      requestBudget: 50,
    });
    expect(res.cells.every((c) => c.availability === 'throttled')).toBe(true);
    expect(res.best).toBeNull();
  });
});

describe('runVariationSearch — budget is a hard stop that admits its gaps', () => {
  it('stops pricing at the budget and REPORTS what it skipped', async () => {
    const priceQuery = pricerReturning(5000);
    const res = await runVariationSearch(
      // 4 combos (2 depart x 2 return, all in range), budget only allows 2.
      spec(),
      PARTY,
      priceQuery,
      { requestBudget: 2 },
    );

    expect(res.totalBeforeCap).toBe(4);
    expect(res.cells).toHaveLength(2);
    expect(res.skippedForBudget).toBe(2);
    expect(res.requestsUsed).toBe(2);
    expect(priceQuery).toHaveBeenCalledTimes(2); // never priced the skipped ones
    // Still surfaces the best of what it DID price — a partial sweep is useful,
    // as long as it is honest about being partial.
    expect(res.best!.total).toBe(5000);
  });

  it('surfaces the grid cap separately from the budget skip', async () => {
    const res = await runVariationSearch(
      spec({ maxCombos: 2 }), // grid itself caps to 2 of 4
      PARTY,
      pricerReturning(5000),
      { requestBudget: 50 },
    );
    expect(res.totalBeforeCap).toBe(4);
    expect(res.droppedByCap).toBe(2);
    expect(res.skippedForBudget).toBe(0);
    expect(res.cells).toHaveLength(2);
  });
});
