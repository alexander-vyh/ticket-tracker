import { describe, it, expect } from 'vitest';
import { lowestAvailablePrice } from './lowest-price';

describe('lowestAvailablePrice', () => {
  it('returns the minimum price among available snapshots', () => {
    const price = lowestAvailablePrice([
      { price: 1200, status: 'available' },
      { price: 950, status: 'available' },
      { price: 1500, status: 'available' },
    ]);
    expect(price).toBe(950);
  });

  it('ignores sold_out snapshots even when they are cheaper (negative control)', () => {
    const price = lowestAvailablePrice([
      { price: 400, status: 'sold_out' },
      { price: 1200, status: 'available' },
    ]);
    expect(price).toBe(1200);
  });

  it('returns null when there are no available snapshots', () => {
    expect(lowestAvailablePrice([])).toBeNull();
    expect(lowestAvailablePrice([{ price: 400, status: 'sold_out' }])).toBeNull();
  });
});
