/**
 * The lowest bookable total price for a tracker, from its price snapshots.
 * A snapshot's price is already the TOTAL for the query's passenger count
 * (Google Flights prices multi-pax queries as one figure, not per-seat), so
 * no passenger multiplier is applied here.
 *
 * 'sold_out' snapshots are excluded: they record what a fare *was*, not
 * something currently bookable, so they must never win a price comparison.
 */
export interface PriceSnapshotLike {
  price: number;
  status: string;
}

export function lowestAvailablePrice(snapshots: PriceSnapshotLike[]): number | null {
  const bookable = snapshots.filter((s) => s.status === 'available' && Number.isFinite(s.price));
  if (bookable.length === 0) return null;
  return Math.min(...bookable.map((s) => s.price));
}
