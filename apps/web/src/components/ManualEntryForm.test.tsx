/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ManualEntryForm, type ManualFormValues } from './ManualEntryForm';

function makeInitialValues(): ManualFormValues {
  return {
    origin: { code: 'MAN', name: 'Manchester (Manchester Airport)' },
    destination: { code: 'HRG', name: 'Hurghada (Hurghada International Airport)' },
    dateFrom: '2026-05-07',
    dateTo: '2026-05-21',
    tripType: 'round_trip',
    flexibility: 0,
    maxPrice: '',
    maxStops: '',
    maxDuration: '',
    airlines: '',
    timePreference: 'any',
    cabinClass: 'economy',
    currency: '',
  };
}

describe('ManualEntryForm — edit flow (issue #60)', () => {
  beforeEach(() => {
    // jsdom does not implement fetch; AirportCombobox calls /api/airports.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: [] }),
    }));
  });

  it('keeps both origin and destination resolved when re-mounting with initialValues', () => {
    render(
      <ManualEntryForm
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        adminCurrency={null}
        initialValues={makeInitialValues()}
      />,
    );

    const origin = screen.getByRole('combobox', { name: /origin/i }) as HTMLInputElement;
    const destination = screen.getByRole('combobox', { name: /destination/i }) as HTMLInputElement;

    // Both fields should display the resolved IATA-prefixed value.
    expect(destination.value).toBe('HRG - Hurghada (Hurghada International Airport)');
    expect(origin.value).toBe('MAN - Manchester (Manchester Airport)');

    // Neither should be flagged invalid on mount.
    expect(origin.getAttribute('aria-invalid')).not.toBe('true');
    expect(destination.getAttribute('aria-invalid')).not.toBe('true');
  });
});
