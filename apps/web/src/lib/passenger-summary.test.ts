import { describe, it, expect } from 'vitest';
import { passengerSummary } from './passenger-summary';

describe('passengerSummary', () => {
  it('returns null for the default single adult (total 1)', () => {
    expect(passengerSummary({ adults: 1, children: 0, infantsInSeat: 0, infantsOnLap: 0 })).toBeNull();
  });

  // Canonical case from the design doc's test scenario (3 adults + 2 children).
  it('formats 3 adults + 2 children as "5 travelers · 3 adults, 2 children"', () => {
    expect(passengerSummary({ adults: 3, children: 2, infantsInSeat: 0, infantsOnLap: 0 }))
      .toBe('5 travelers · 3 adults, 2 children');
  });

  it('labels lap and seat infants separately', () => {
    expect(passengerSummary({ adults: 2, children: 0, infantsInSeat: 1, infantsOnLap: 1 }))
      .toBe('4 travelers · 2 adults, 1 infant (seat), 1 infant (lap)');
  });

  it('singularizes each bucket when its count is exactly 1', () => {
    expect(passengerSummary({ adults: 1, children: 1, infantsInSeat: 0, infantsOnLap: 0 }))
      .toBe('2 travelers · 1 adult, 1 child');
  });

  it('omits a bucket entirely when its count is 0 (negative control)', () => {
    // children=0 must not appear as "0 children" in the string.
    expect(passengerSummary({ adults: 2, children: 0, infantsInSeat: 0, infantsOnLap: 0 }))
      .toBe('2 travelers · 2 adults');
  });
});
