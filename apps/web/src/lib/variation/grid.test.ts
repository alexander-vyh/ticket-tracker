import { describe, it, expect } from 'vitest';
import { expandVariationGrid, type VariationSpec } from './grid';

/** The real trip: LAX → NZ over the 2026-27 holidays, ~3 weeks. */
function spec(over: Partial<VariationSpec> = {}): VariationSpec {
  return {
    origin: 'LAX',
    destinations: ['AKL'],
    departWindow: { from: '2026-12-10', to: '2026-12-16' },
    returnWindow: { from: '2027-01-01', to: '2027-01-07' },
    stayNights: { min: 18, max: 24 },
    shapes: ['round_trip'],
    maxCombos: 100,
    ...over,
  };
}

describe('expandVariationGrid — shapes', () => {
  it('round_trip flies out to and home from the SAME gateway', () => {
    const { candidates } = expandVariationGrid(spec());
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.shape).toBe('round_trip');
      expect(c.outbound.from).toBe('LAX');
      expect(c.outbound.to).toBe('AKL');
      expect(c.inbound.from).toBe('AKL');
      expect(c.inbound.to).toBe('LAX');
    }
  });

  it('open_jaw emits every ORDERED gateway pair with different in/out cities', () => {
    const { candidates } = expandVariationGrid(
      spec({
        destinations: ['AKL', 'CHC'],
        shapes: ['open_jaw'],
        departWindow: { from: '2026-12-10', to: '2026-12-10' },
        returnWindow: { from: '2027-01-01', to: '2027-01-01' },
        stayNights: { min: 0, max: 40 },
      }),
    );
    // Exactly the two ordered pairs: in AKL/out CHC, and in CHC/out AKL.
    expect(candidates).toHaveLength(2);
    const routes = candidates.map((c) => `${c.outbound.to}->${c.inbound.from}`).sort();
    expect(routes).toEqual(['AKL->CHC', 'CHC->AKL']);
    // Never a same-gateway "open jaw" — that would just be a round trip.
    for (const c of candidates) {
      expect(c.outbound.to).not.toBe(c.inbound.from);
    }
  });

  it('two_one_ways reuses the round-trip legs (it is an availability fallback, not a route change)', () => {
    const { candidates } = expandVariationGrid(
      spec({ shapes: ['round_trip', 'two_one_ways'] }),
    );
    const rt = candidates.filter((c) => c.shape === 'round_trip');
    const ow = candidates.filter((c) => c.shape === 'two_one_ways');
    expect(rt.length).toBe(ow.length);
    expect(ow[0]!.outbound).toEqual(rt[0]!.outbound);
    expect(ow[0]!.inbound).toEqual(rt[0]!.inbound);
  });
});

describe('expandVariationGrid — stay-length filter', () => {
  it('keeps only pairs inside the stay-night range', () => {
    const { candidates } = expandVariationGrid(spec({ stayNights: { min: 20, max: 21 } }));
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.stayNights).toBeGreaterThanOrEqual(20);
      expect(c.stayNights).toBeLessThanOrEqual(21);
    }
  });

  it('excludes a return that lands before the departure (negative stay)', () => {
    const { candidates } = expandVariationGrid(
      spec({
        departWindow: { from: '2026-12-20', to: '2026-12-20' },
        returnWindow: { from: '2026-12-10', to: '2026-12-10' },
        stayNights: { min: -99, max: 99 }, // even with a permissive range…
      }),
    );
    // …a -10 night "stay" is nonsense; min is what excludes it here, so assert the
    // real guard: no candidate ever has a return before its departure.
    for (const c of candidates) {
      expect(c.inbound.date >= c.outbound.date).toBe(true);
    }
  });

  it('generates the full depart x return matrix when the range permits', () => {
    // 7 depart days x 7 return days, all within a wide stay range.
    const { candidates, totalBeforeCap } = expandVariationGrid(
      spec({ stayNights: { min: 0, max: 60 }, maxCombos: 1000 }),
    );
    expect(totalBeforeCap).toBe(49);
    expect(candidates).toHaveLength(49);
  });
});

describe('expandVariationGrid — cap samples evenly (never truncates)', () => {
  it('reports what the cap dropped instead of silently swallowing it', () => {
    const grid = expandVariationGrid(
      spec({ stayNights: { min: 0, max: 60 }, maxCombos: 10 }),
    );
    expect(grid.totalBeforeCap).toBe(49);
    expect(grid.candidates).toHaveLength(10);
    expect(grid.droppedByCap).toBe(39);
  });

  it('a capped grid still SPANS the window — keeps the first and last combos', () => {
    const full = expandVariationGrid(
      spec({ stayNights: { min: 0, max: 60 }, maxCombos: 1000 }),
    ).candidates;
    const capped = expandVariationGrid(
      spec({ stayNights: { min: 0, max: 60 }, maxCombos: 5 }),
    ).candidates;

    // The whole point of even sampling: we must not collapse onto the earliest
    // dates, because date choice is what drives price.
    expect(capped[0]!.id).toBe(full[0]!.id);
    expect(capped.at(-1)!.id).toBe(full.at(-1)!.id);
    expect(new Set(capped.map((c) => c.id)).size).toBe(5);
  });

  it('leaves the grid untouched when it already fits under the cap', () => {
    const grid = expandVariationGrid(spec({ maxCombos: 1000 }));
    expect(grid.droppedByCap).toBe(0);
  });
});

describe('expandVariationGrid — misc', () => {
  it('dateStepDays coarsens a wide window before the cap has to bite', () => {
    const fine = expandVariationGrid(spec({ stayNights: { min: 0, max: 60 }, maxCombos: 1000 }));
    const coarse = expandVariationGrid(
      spec({ stayNights: { min: 0, max: 60 }, maxCombos: 1000, dateStepDays: 3 }),
    );
    expect(coarse.totalBeforeCap).toBeLessThan(fine.totalBeforeCap);
  });

  it('gives each distinct itinerary a stable, unique id', () => {
    const a = expandVariationGrid(spec({ stayNights: { min: 0, max: 60 } })).candidates;
    const b = expandVariationGrid(spec({ stayNights: { min: 0, max: 60 } })).candidates;
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id)); // stable across runs
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length); // unique
  });

  it('multiplies across gateways (the "which NZ city" axis)', () => {
    const one = expandVariationGrid(spec({ destinations: ['AKL'], maxCombos: 1000 }));
    const four = expandVariationGrid(
      spec({ destinations: ['AKL', 'CHC', 'WLG', 'ZQN'], maxCombos: 1000 }),
    );
    expect(four.totalBeforeCap).toBe(one.totalBeforeCap * 4);
  });

  it('returns an empty grid for an inverted window rather than throwing', () => {
    const grid = expandVariationGrid(
      spec({ departWindow: { from: '2026-12-20', to: '2026-12-10' } }),
    );
    expect(grid.candidates).toHaveLength(0);
    expect(grid.totalBeforeCap).toBe(0);
  });
});
