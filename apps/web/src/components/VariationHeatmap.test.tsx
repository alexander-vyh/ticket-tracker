/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { VariationHeatmap, type HeatmapCell } from './VariationHeatmap';

afterEach(cleanup);

function cell(
  over: Omit<Partial<HeatmapCell>, 'candidate'> & {
    dep: string;
    ret: string;
    candidate?: Partial<HeatmapCell['candidate']>;
  },
): HeatmapCell {
  // `candidate` is pulled out explicitly — spreading it back in via ...rest would
  // clobber the merged candidate with the caller's partial.
  const { dep, ret, candidate: candidateOver, ...rest } = over;
  const shape = candidateOver?.shape ?? 'round_trip';
  return {
    candidate: {
      id: `${dep}|${ret}|${shape}`,
      shape,
      outbound: { from: 'LAX', to: 'AKL', date: dep },
      inbound: { from: 'AKL', to: 'LAX', date: ret },
      stayNights: 21,
      ...(candidateOver ?? {}),
    },
    total: 5000,
    currency: 'USD',
    availability: 'available',
    ...rest,
  };
}

describe('VariationHeatmap', () => {
  it('leads with the cheapest fare the sweep found', () => {
    render(
      <VariationHeatmap
        cells={[
          cell({ dep: '2026-12-13', ret: '2027-01-03', total: 6200 }),
          cell({ dep: '2026-12-14', ret: '2027-01-03', total: 4975 }),
        ]}
      />,
    );
    // The cheapest fare legitimately appears in three places: the hero, its own
    // cell, and the legend's low end. Assert the hero specifically.
    expect(screen.getAllByText('$4,975').length).toBeGreaterThan(0);
    expect(screen.getByText(/cheapest —/)).toBeTruthy();
    // …and the dearer fare is NOT the headline.
    expect(screen.getByText(/cheapest —/).previousSibling?.textContent).toBe('$4,975');
  });

  it('marks the cheapest cell instead of recolouring it (the ramp stays honest)', () => {
    render(
      <VariationHeatmap
        cells={[
          cell({ dep: '2026-12-13', ret: '2027-01-03', total: 6200 }),
          cell({ dep: '2026-12-14', ret: '2027-01-03', total: 4975 }),
        ]}
      />,
    );
    // The winning cell is tagged, and its aria-label says so.
    expect(screen.getByText('best')).toBeTruthy();
    expect(screen.getByLabelText(/Dec 14 to Jan 3: \$4,975, cheapest/)).toBeTruthy();
  });

  it('renders a sold-out date as a labelled state, never as a price', () => {
    render(
      <VariationHeatmap
        cells={[
          cell({ dep: '2026-12-13', ret: '2027-01-03', total: null, availability: 'no_options' }),
        ]}
      />,
    );
    // A pale ramp step means "cheap" — a sold-out cell must never be mistaken for
    // the bargain of the sweep. It carries a glyph AND a label.
    const soldOut = screen.getByLabelText(/Dec 13 to Jan 3: Sold out/);
    expect(soldOut.textContent).toBe('✕');
    expect(screen.queryByText(/\$/)).toBeNull(); // no price anywhere
    expect(screen.getByText(/No bookable itinerary found/)).toBeTruthy();
  });

  it('distinguishes "not checked" (throttled) from "sold out" — we never claim a route is gone when we did not look', () => {
    render(
      <VariationHeatmap
        cells={[
          cell({ dep: '2026-12-13', ret: '2027-01-03', total: null, availability: 'throttled' }),
        ]}
      />,
    );
    const throttled = screen.getByLabelText(/Dec 13 to Jan 3: Not checked/);
    expect(throttled.textContent).toBe('?');
  });

  it('prefers a bookable itinerary over an unbookable one for the same date pair', () => {
    render(
      <VariationHeatmap
        cells={[
          // Same coordinate: an open jaw that is sold out, and a priced round trip.
          cell({
            dep: '2026-12-13',
            ret: '2027-01-03',
            total: null,
            availability: 'no_options',
            candidate: { shape: 'open_jaw' },
          }),
          cell({ dep: '2026-12-13', ret: '2027-01-03', total: 4975 }),
        ]}
      />,
    );
    // The sold-out shape must not hide the bookable one.
    expect(screen.getByLabelText(/Dec 13 to Jan 3: \$4,975/)).toBeTruthy();
  });

  it('flags a partial sweep rather than letting it look complete', () => {
    render(
      <VariationHeatmap
        cells={[cell({ dep: '2026-12-13', ret: '2027-01-03', total: 4975 })]}
        coverage={{
          priced: 1,
          totalBeforeCap: 49,
          droppedByCap: 30,
          skippedForBudget: 18,
          complete: false,
        }}
      />,
    );
    expect(screen.getByText(/Partial sweep/)).toBeTruthy();
    expect(screen.getByText(/18 left unpriced/)).toBeTruthy();
  });

  it('says so plainly when a sweep is complete', () => {
    render(
      <VariationHeatmap
        cells={[cell({ dep: '2026-12-13', ret: '2027-01-03', total: 4975 })]}
        coverage={{
          priced: 1,
          totalBeforeCap: 1,
          droppedByCap: 0,
          skippedForBudget: 0,
          complete: true,
        }}
      />,
    );
    expect(screen.getByText('Complete sweep.')).toBeTruthy();
  });

  it('always ships a legend so state is never carried by colour alone', () => {
    render(<VariationHeatmap cells={[cell({ dep: '2026-12-13', ret: '2027-01-03' })]} />);
    expect(screen.getByText('Sold out')).toBeTruthy();
    expect(screen.getByText('Not checked')).toBeTruthy();
    expect(screen.getByText('Not searched')).toBeTruthy();
  });

  it('handles an empty sweep without blowing up', () => {
    render(<VariationHeatmap cells={[]} />);
    expect(screen.getByText(/No itineraries were priced/)).toBeTruthy();
  });
});
