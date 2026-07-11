/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiLegForm, deriveTripShape } from './MultiLegForm';

// oracle: the trip-shape derivation mirrors Google's own rule (a 2-leg trip
// whose return does not reverse the outbound is an open jaw, not a round trip),
// the same rule the server's parseSegments and the tfs-builder enforce and that
// was browser-verified against Google Flights 2026-07-10. The submitted payload
// shape is the /api/queries contract, not an implementation echo.

describe('deriveTripShape', () => {
  it('labels a reversing 2-leg trip as round trip', () => {
    expect(
      deriveTripShape([
        { from: 'LAX', to: 'AKL', date: '2026-12-18' },
        { from: 'AKL', to: 'LAX', date: '2027-01-08' },
      ]),
    ).toBe('round_trip');
  });
  it('labels a non-reversing 2-leg trip as open jaw', () => {
    expect(
      deriveTripShape([
        { from: 'LAX', to: 'AKL', date: '2026-12-18' },
        { from: 'CHC', to: 'LAX', date: '2027-01-08' },
      ]),
    ).toBe('open_jaw');
  });
  it('labels 3+ legs as multi city', () => {
    expect(
      deriveTripShape([
        { from: 'LAX', to: 'AKL', date: '2026-12-18' },
        { from: 'AKL', to: 'SYD', date: '2026-12-28' },
        { from: 'SYD', to: 'LAX', date: '2027-01-08' },
      ]),
    ).toBe('multi_city');
  });
});

describe('MultiLegForm', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, data: { queries: [{ id: 'q1' }] } }),
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('starts with two legs and can add a third', () => {
    render(<MultiLegForm />);
    expect(screen.getAllByLabelText(/From/i)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /add leg/i }));
    expect(screen.getAllByLabelText(/From/i)).toHaveLength(3);
  });

  it('shows the derived trip shape as the user fills an open jaw', () => {
    render(<MultiLegForm />);
    const from = screen.getAllByLabelText(/From/i) as HTMLInputElement[];
    const to = screen.getAllByLabelText(/To/i) as HTMLInputElement[];
    const date = screen.getAllByLabelText(/Date/i) as HTMLInputElement[];
    fireEvent.change(from[0]!, { target: { value: 'LAX' } });
    fireEvent.change(to[0]!, { target: { value: 'AKL' } });
    fireEvent.change(date[0]!, { target: { value: '2026-12-18' } });
    fireEvent.change(from[1]!, { target: { value: 'CHC' } });
    fireEvent.change(to[1]!, { target: { value: 'LAX' } });
    fireEvent.change(date[1]!, { target: { value: '2027-01-08' } });
    expect(screen.getByText(/open jaw/i)).toBeInTheDocument();
  });

  it('submits the segments array (open jaw) to /api/queries', async () => {
    render(<MultiLegForm adults={3} children={2} />);
    const from = screen.getAllByLabelText(/From/i) as HTMLInputElement[];
    const to = screen.getAllByLabelText(/To/i) as HTMLInputElement[];
    const date = screen.getAllByLabelText(/Date/i) as HTMLInputElement[];
    fireEvent.change(from[0]!, { target: { value: 'lax' } }); // lower-case → server upper-cases
    fireEvent.change(to[0]!, { target: { value: 'AKL' } });
    fireEvent.change(date[0]!, { target: { value: '2026-12-18' } });
    fireEvent.change(from[1]!, { target: { value: 'CHC' } });
    fireEvent.change(to[1]!, { target: { value: 'LAX' } });
    fireEvent.change(date[1]!, { target: { value: '2027-01-08' } });
    fireEvent.click(screen.getByRole('button', { name: /track|search|create/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('/api/queries');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.segments).toEqual([
      { from: 'LAX', to: 'AKL', date: '2026-12-18' },
      { from: 'CHC', to: 'LAX', date: '2027-01-08' },
    ]);
    expect(body.adults).toBe(3);
    expect(body.children).toBe(2);
  });

  it('blocks submit until every leg has from, to, and date', () => {
    render(<MultiLegForm />);
    fireEvent.click(screen.getByRole('button', { name: /track|search|create/i }));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/every leg needs|fill/i)).toBeInTheDocument();
  });
});
