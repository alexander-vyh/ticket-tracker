/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiLegEntryForm } from './MultiLegEntryForm';

interface StubAirport {
  code: string;
  name: string;
  city: string;
  country: string;
}

const AIRPORTS: StubAirport[] = [
  { code: 'LAX', name: 'Los Angeles International Airport', city: 'Los Angeles', country: 'US' },
  { code: 'AKL', name: 'Auckland Airport', city: 'Auckland', country: 'NZ' },
  { code: 'CHC', name: 'Christchurch Airport', city: 'Christchurch', country: 'NZ' },
];

function installFetchStub(onCreateQueries: () => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/airports')) {
      const q = new URL(url, 'http://localhost').searchParams.get('q')?.toLowerCase() ?? '';
      const data = AIRPORTS.filter((a) => a.code.toLowerCase().includes(q));
      return { ok: true, json: async () => ({ ok: true, data }) } as Response;
    }
    if (url === '/api/queries') {
      return { ok: true, json: async () => ({ ok: true, data: { queries: onCreateQueries() } }) } as Response;
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function selectAirport(name: RegExp, code: string) {
  const input = screen.getByRole('combobox', { name });
  await userEvent.type(input, code);
  const option = await waitFor(() => screen.getByRole('option', { name: new RegExp(code) }));
  await userEvent.click(option);
}

describe('MultiLegEntryForm', () => {
  beforeEach(() => {
    installFetchStub(() => []);
  });

  it('starts with 2 legs and no derived shape until both airports of every leg are chosen', () => {
    render(<MultiLegEntryForm onCreated={vi.fn()} onCancel={vi.fn()} adminCurrency={null} />);
    expect(screen.getByTestId('leg-0')).toBeTruthy();
    expect(screen.getByTestId('leg-1')).toBeTruthy();
    expect(screen.queryByTestId('leg-2')).toBeNull();
    expect(screen.queryByTestId('derived-trip-type')).toBeNull();
  });

  it('adds up to 6 legs and disables further additions past the max', async () => {
    render(<MultiLegEntryForm onCreated={vi.fn()} onCancel={vi.fn()} adminCurrency={null} />);
    const addButton = screen.getByRole('button', { name: /add leg/i });
    for (let i = 0; i < 4; i++) {
      await userEvent.click(addButton);
    }
    expect(screen.getByTestId('leg-5')).toBeTruthy();
    expect(addButton).toBeDisabled();
  });

  it('derives "Open jaw" for a non-reversing 2-leg itinerary (LAX->AKL, CHC->LAX)', async () => {
    render(<MultiLegEntryForm onCreated={vi.fn()} onCancel={vi.fn()} adminCurrency={null} />);

    await selectAirport(/^Origin$/i, 'LAX');
    await selectAirport(/leg 1 destination/i, 'AKL');
    await selectAirport(/leg 2 origin/i, 'CHC');
    await selectAirport(/final destination/i, 'LAX');

    await waitFor(() => {
      expect(screen.getByTestId('derived-trip-type').textContent).toBe('Open jaw');
    });
  });

  it('derives "Round trip" for a reversing 2-leg itinerary (LAX->AKL, AKL->LAX) — negative control against the open-jaw case', async () => {
    render(<MultiLegEntryForm onCreated={vi.fn()} onCancel={vi.fn()} adminCurrency={null} />);

    await selectAirport(/^Origin$/i, 'LAX');
    await selectAirport(/leg 1 destination/i, 'AKL');
    await selectAirport(/leg 2 origin/i, 'AKL');
    await selectAirport(/final destination/i, 'LAX');

    await waitFor(() => {
      expect(screen.getByTestId('derived-trip-type').textContent).toBe('Round trip');
    });
  });

  it('submits the segments array with the derived shape and reports the created trackers', async () => {
    const created = [
      {
        id: 'q1',
        origin: 'LAX',
        originName: 'Los Angeles',
        destination: 'AKL',
        destinationName: 'Auckland',
        date: '2026-12-18',
        deleteToken: 'tok-1',
        label: null,
      },
    ];
    const fetchMock = installFetchStub(() => created);
    const onCreated = vi.fn();

    render(<MultiLegEntryForm onCreated={onCreated} onCancel={vi.fn()} adminCurrency="USD" />);

    await selectAirport(/^Origin$/i, 'LAX');
    await selectAirport(/leg 1 destination/i, 'AKL');
    await selectAirport(/leg 2 origin/i, 'CHC');
    await selectAirport(/final destination/i, 'LAX');

    fireEvent.change(within(screen.getByTestId('leg-0')).getByLabelText('Date'), {
      target: { value: '2026-12-18' },
    });
    fireEvent.change(within(screen.getByTestId('leg-1')).getByLabelText('Date'), {
      target: { value: '2027-01-08' },
    });

    await userEvent.click(screen.getByRole('button', { name: /create tracker/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    // The API response's per-tracker `date` field is only populated for the
    // `routes` array request format (not this one), so the caller must get
    // the real leg dates from the callback args, not from `created[0].date` —
    // caught live as trackers showing "Invalid Date" on the compare page.
    expect(onCreated).toHaveBeenCalledWith(created, 'open_jaw', '2026-12-18', '2027-01-08');

    const queriesCall = fetchMock.mock.calls.find(([input]) => input === '/api/queries');
    expect(queriesCall).toBeDefined();
    const body = JSON.parse((queriesCall![1] as RequestInit).body as string);
    expect(body.segments).toEqual([
      { from: 'LAX', to: 'AKL', date: '2026-12-18' },
      { from: 'CHC', to: 'LAX', date: '2027-01-08' },
    ]);
    expect(body.dateFrom).toBe('2026-12-18');
    expect(body.dateTo).toBe('2027-01-08');
    // /api/queries rejects requests with segments but no top-level
    // origin/destination ("Missing required fields: routes array or
    // origin/destination") — caught live against the real API before this
    // assertion existed, since a fetch-stub test only checking `segments`
    // cannot see that the real server has an independent requirement.
    expect(body.origin).toBe('LAX');
    expect(body.destination).toBe('LAX');
    expect(body.originName).toBeTruthy();
    expect(body.destinationName).toBeTruthy();
  });

  // oracle: apps/web/src/app/api/queries/route.ts's parseSegments() rejects
  // any leg whose date fails `/^\d{4}-\d{2}-\d{2}$/` with a 400 ("segment N:
  // 'date' must be YYYY-MM-DD") — that server-side contract is the
  // independent source of truth this test proves the client honors before a
  // request is even sent. The two assertions below are both externally
  // observable, not mock bookkeeping: the visible field error the user reads
  // (DOM text), and that no /api/queries request left the browser at all
  // (checked directly against the fetch spy, not by asking whether onCreated
  // — an implementation-internal callback — happened to run).
  it('blocks submission with a field error when a leg is missing a date, and never calls the API (negative control)', async () => {
    const fetchMock = installFetchStub(() => []);
    render(<MultiLegEntryForm onCreated={vi.fn()} onCancel={vi.fn()} adminCurrency={null} />);

    await selectAirport(/^Origin$/i, 'LAX');
    await selectAirport(/leg 1 destination/i, 'AKL');
    await selectAirport(/leg 2 origin/i, 'CHC');
    await selectAirport(/final destination/i, 'LAX');
    // Leave both dates empty.

    await userEvent.click(screen.getByRole('button', { name: /create tracker/i }));

    expect(await within(screen.getByTestId('leg-0')).findByText('Select a date')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/queries')).toBe(false);
  });
});
