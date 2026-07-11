/**
 * Compact "N travelers · breakdown" label shared by the tracker list cards
 * and the chart page header. Returns null for the default single adult
 * (total <= 1) so callers can skip rendering it entirely -- most trackers
 * are solo and the summary would be pure noise.
 */
export interface PassengerCounts {
  adults: number;
  children: number;
  infantsInSeat: number;
  infantsOnLap: number;
}

export function passengerSummary(q: PassengerCounts): string | null {
  const total = q.adults + q.children + q.infantsInSeat + q.infantsOnLap;
  if (total <= 1) return null;
  const parts = [
    `${q.adults} ${q.adults === 1 ? 'adult' : 'adults'}`,
    q.children > 0 ? `${q.children} ${q.children === 1 ? 'child' : 'children'}` : null,
    q.infantsInSeat > 0 ? `${q.infantsInSeat} infant${q.infantsInSeat === 1 ? '' : 's'} (seat)` : null,
    q.infantsOnLap > 0 ? `${q.infantsOnLap} infant${q.infantsOnLap === 1 ? '' : 's'} (lap)` : null,
  ].filter(Boolean);
  return `${total} travelers · ${parts.join(', ')}`;
}
