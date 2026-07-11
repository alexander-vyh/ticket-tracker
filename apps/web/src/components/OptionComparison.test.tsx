/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OptionComparison } from './OptionComparison';
import type { SavedTracker } from '@/lib/tracker-storage';

const roundTrip: SavedTracker = {
  id: 'rt-1',
  origin: 'LAX',
  destination: 'AKL',
  originName: 'Los Angeles',
  destinationName: 'Auckland',
  dateFrom: '2026-12-18',
  dateTo: '2027-01-08',
  createdAt: '2026-07-01T00:00:00.000Z',
  label: 'RT',
};

const openJaw: SavedTracker = {
  id: 'oj-1',
  origin: 'LAX',
  destination: 'AKL',
  originName: 'Los Angeles',
  destinationName: 'Auckland',
  dateFrom: '2026-12-18',
  dateTo: '2027-01-08',
  createdAt: '2026-07-01T00:00:00.000Z',
  label: 'Open jaw',
};

function pricesResponse(overrides: {
  tripType: string;
  segments?: unknown;
  snapshots: Array<{ price: number; status: string }>;
}) {
  return {
    ok: true,
    data: {
      query: {
        origin: 'LAX',
        destination: 'AKL',
        tripType: overrides.tripType,
        segments: overrides.segments ?? null,
        adults: 3,
        children: 2,
        infantsInSeat: 0,
        infantsOnLap: 0,
        currency: 'USD',
      },
      snapshots: overrides.snapshots,
      lastChecked: '2026-07-10T00:00:00.000Z',
    },
  };
}

describe('OptionComparison', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/queries/rt-1/prices') {
          // The round-trip tracker has NO bookable inventory for this window
          // (canonical case from the design doc), only a sold-out snapshot.
          return {
            ok: true,
            json: async () => pricesResponse({ tripType: 'round_trip', snapshots: [{ price: 400, status: 'sold_out' }] }),
          } as Response;
        }
        if (url === '/api/queries/oj-1/prices') {
          return {
            ok: true,
            json: async () =>
              pricesResponse({
                tripType: 'open_jaw',
                segments: [
                  { from: 'LAX', to: 'AKL', date: '2026-12-18' },
                  { from: 'CHC', to: 'LAX', date: '2027-01-08' },
                ],
                snapshots: [{ price: 9398, status: 'available' }],
              }),
          } as Response;
        }
        throw new Error(`Unexpected fetch to ${url}`);
      }),
    );
  });

  it('shows each tracker\'s lowest AVAILABLE price and flags the actual cheapest, ignoring a sold-out price that looks cheaper', async () => {
    render(<OptionComparison trackers={[roundTrip, openJaw]} />);

    await waitFor(() => {
      expect(within(screen.getByTestId('comparison-card-rt-1')).getByText('No price yet')).toBeTruthy();
    });
    expect(within(screen.getByTestId('comparison-card-oj-1')).getByText('USD 9,398')).toBeTruthy();

    // Negative control: the round-trip card has no bookable price at all, so
    // it must never be flagged "Cheapest" — only the open-jaw card, which
    // has the only real available price, may carry the badge.
    expect(within(screen.getByTestId('comparison-card-oj-1')).getByText('Cheapest')).toBeTruthy();
    expect(within(screen.getByTestId('comparison-card-rt-1')).queryByText('Cheapest')).toBeNull();
  });

  it('renders the open-jaw route as its two legs, not a single origin-destination pair', async () => {
    render(<OptionComparison trackers={[openJaw]} />);

    await waitFor(() => {
      expect(within(screen.getByTestId('comparison-card-oj-1')).getByText('LAX → AKL, CHC → LAX')).toBeTruthy();
    });
    expect(within(screen.getByTestId('comparison-card-oj-1')).getByText('Open jaw')).toBeTruthy();
  });

  it('removes a tracker from the comparison grid when its checkbox is unchecked', async () => {
    render(<OptionComparison trackers={[roundTrip, openJaw]} />);
    await waitFor(() => expect(screen.getByTestId('comparison-card-rt-1')).toBeTruthy());

    await userEvent.click(screen.getByRole('checkbox', { name: /rt/i }));

    expect(screen.queryByTestId('comparison-card-rt-1')).toBeNull();
    expect(screen.getByTestId('comparison-card-oj-1')).toBeTruthy();
  });

  it('shows an empty-state message with no trackers instead of an empty grid', () => {
    render(<OptionComparison trackers={[]} />);
    expect(screen.getByText(/no trackers yet/i)).toBeTruthy();
  });
});
