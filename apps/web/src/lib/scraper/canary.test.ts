import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TfsQuery } from '../dataplane/tfs-builder';
import { cellKeyOf, isStrictlySmallerParty, samePartyTuple } from '../dataplane/no-options-guard';
import type { FlightSearchParams } from './navigate';

// oracle: Google gates parties of >= 4 with a FABRICATED "No options" page on
// every date (measured 2026-07-11; see no-options-guard.ts). Two consequences
// these tests exist to pin, both of which the previous canary got wrong:
//
//   1. A canary MUST carry the guarded query's own party. The old
//      adultsOnlyVariant() canary stripped the children, so a 3a+2c family was
//      vouched for by a 3-ADULT probe — which passes the gate all night and
//      would certify the fabricated 5-pax zero as a real sold-out.
//   2. A canary MUST exercise the tier it vouches for. The old one ran fetchSsr
//      while the result it certified came from the BROWSER, so a browser
//      soft-block left it green.

const { mockNavigateGoogleFlightsUrl } = vi.hoisted(() => ({ mockNavigateGoogleFlightsUrl: vi.fn() }));

vi.mock('./navigate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./navigate')>();
  return { ...actual, navigateGoogleFlightsUrl: (...args: unknown[]) => mockNavigateGoogleFlightsUrl(...args) };
});

import {
  createMonotonicityProbe,
  createPartyMatchedCanary,
  defaultReferenceCell,
  isReferenceCellUsable,
  type ProbeDeps,
} from './canary';

const PAIR_PARAMS: FlightSearchParams = {
  origin: 'LAX',
  destination: 'AKL',
  dateFrom: new Date('2026-12-10'),
  dateTo: new Date('2026-12-28'),
  tripType: 'round_trip',
  cabinClass: 'economy',
  currency: 'USD',
};

const DEPS: ProbeDeps = {
  countryProfile: undefined,
  proxyUrl: undefined,
  currency: 'USD',
  pairParams: PAIR_PARAMS,
};

const FAMILY: TfsQuery = {
  trip: 'round-trip',
  seat: 'economy',
  segments: [
    { date: '2026-12-10', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2026-12-28', fromAirport: 'AKL', toAirport: 'LAX' },
  ],
  passengers: { adults: 3, children: 2 },
};

beforeEach(() => vi.clearAllMocks());

describe('createPartyMatchedCanary', () => {
  it('runs the reference cell at the GUARDED QUERY\'S OWN PARTY — not adults-only, not one adult', async () => {
    // The 45a invariant, asserted on the probe's own self-report: whatever party
    // Google just refused to answer for is the party the canary must ask about.
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'u', resultsFound: true, source: 'google_flights' });

    const probe = await createPartyMatchedCanary(DEPS)(FAMILY);

    expect(probe.passengers).toEqual({ adults: 3, children: 2 });
    expect(samePartyTuple(probe.passengers, FAMILY.passengers)).toBe(true);
    expect(probe.foundFlights).toBe(true);
  });

  it('probes a DIFFERENT cell than the query under test, so it is an independent control', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'u', resultsFound: true, source: 'google_flights' });

    const probe = await createPartyMatchedCanary(DEPS)(FAMILY);

    expect(probe.cellKey).not.toBe(cellKeyOf(FAMILY));
    expect(probe.cellKey).toContain(defaultReferenceCell().departDate);
    // And it must navigate against the REFERENCE route's params, or the page's
    // route/date verification would be checking the wrong itinerary.
    const [, params] = mockNavigateGoogleFlightsUrl.mock.calls[0]!;
    expect((params as FlightSearchParams).origin).toBe(defaultReferenceCell().origin);
    expect((params as FlightSearchParams).destination).toBe(defaultReferenceCell().destination);
  });

  it('goes through the BROWSER tier — the tier it is vouching for', async () => {
    // The old canary ran fetchSsr, so a browser soft-block (the exact failure it
    // existed to catch) left it green. Party size must be the only variable that
    // differs between probe and target; the channel must not.
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'u', resultsFound: true, source: 'google_flights' });
    await createPartyMatchedCanary(DEPS)(FAMILY);
    expect(mockNavigateGoogleFlightsUrl).toHaveBeenCalledTimes(1);
  });

  it('reports no inventory when the reference cell comes back empty (the >=4 gate)', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'u', resultsFound: false, noOptions: true, source: 'google_flights' });

    const probe = await createPartyMatchedCanary(DEPS)(FAMILY);

    expect(probe.foundFlights).toBe(false);
  });

  it('fails CLOSED when the probe throws — a crashed canary saw no inventory', async () => {
    mockNavigateGoogleFlightsUrl.mockRejectedValue(new Error('browser died'));

    const probe = await createPartyMatchedCanary(DEPS)(FAMILY);

    // false can only ever push the verdict toward `unverified`; a throw must never
    // be mistaken for a passing canary.
    expect(probe.foundFlights).toBe(false);
  });
});

describe('createMonotonicityProbe', () => {
  it('re-runs the TARGET cell at a strictly smaller party — party is the only variable', async () => {
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'u', resultsFound: true, source: 'google_flights' });

    const probe = await createMonotonicityProbe(DEPS)(FAMILY);

    expect(probe.cellKey).toBe(cellKeyOf(FAMILY)); // same route, same dates
    expect(isStrictlySmallerParty(probe.passengers, FAMILY.passengers)).toBe(true);
    expect(probe.passengers.adults).toBe(1);
    expect(probe.passengers.children).toBe(0);
  });

  it('reports FOUND when a single adult prices a cell the full party could not — the fabrication signal', async () => {
    // This is exactly the observation that exposed the gate: 1 adult -> 8 results
    // on a cell where 5 pax returned "No options".
    mockNavigateGoogleFlightsUrl.mockResolvedValue({ html: '', url: 'u', resultsFound: true, source: 'google_flights' });

    const probe = await createMonotonicityProbe(DEPS)(FAMILY);

    expect(probe.foundFlights).toBe(true);
  });

  it('fails CLOSED when the probe throws', async () => {
    mockNavigateGoogleFlightsUrl.mockRejectedValue(new Error('browser died'));
    const probe = await createMonotonicityProbe(DEPS)(FAMILY);
    expect(probe.foundFlights).toBe(false);
  });
});

describe('the reference cell cannot expire', () => {
  // ticket-tracker-0gr. The cell used to be hard-coded to Dec 2026. Once those dates
  // passed, Google would price nothing for them, the canary would be permanently empty,
  // every empty result would become `unverified`, and the tracker would SILENTLY lose the
  // ability to report a sold-out at all. Safe, but silently broken — a guard that has
  // stopped guarding while still looking healthy.

  it('rolls forward with the clock — it is always in the future, at any date', () => {
    for (const iso of ['2026-07-13', '2027-01-01', '2030-06-30', '2099-12-31']) {
      const now = new Date(`${iso}T12:00:00Z`);
      const cell = defaultReferenceCell(now);
      expect(cell.departDate > iso).toBe(true);
      expect(cell.returnDate > cell.departDate).toBe(true);
      expect(isReferenceCellUsable(cell, now)).toBe(true);
    }
  });

  it('rejects an INJECTED cell whose departure has already passed', () => {
    const now = new Date('2027-03-01T12:00:00Z');
    const stale = { origin: 'LAX', destination: 'AKL', departDate: '2026-12-01', returnDate: '2026-12-22' };
    expect(isReferenceCellUsable(stale, now)).toBe(false);
  });

  it('a STALE injected cell reports NO inventory, so no sold-out can ever be confirmed from it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const canary = createPartyMatchedCanary({
      ...DEPS,
      referenceCell: { origin: 'LAX', destination: 'AKL', departDate: '2026-12-01', returnDate: '2026-12-22' },
      now: new Date('2027-03-01T12:00:00Z'),
    });
    const probe = await canary(FAMILY);

    // foundFlights=false is the ONLY value that can never license a sold-out claim.
    expect(probe.foundFlights).toBe(false);
    // …and it must SAY so. A silently dead canary is the bug.
    expect(err).toHaveBeenCalledWith(expect.stringContaining('STALE REFERENCE CELL'));
    err.mockRestore();
  });
});
