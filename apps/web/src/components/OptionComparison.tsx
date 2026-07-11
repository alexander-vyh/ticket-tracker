'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SavedTracker } from '@/lib/tracker-storage';
import { lowestAvailablePrice } from '@/lib/lowest-price';
import { passengerSummary, type PassengerCounts } from '@/lib/passenger-summary';
import { tripTypeLabel, type SegmentsTripType } from '@/lib/segments';
import styles from './OptionComparison.module.css';

interface Segment {
  from: string;
  to: string;
  date: string;
}

interface ComparisonEntry {
  status: 'loading' | 'ready' | 'error';
  origin?: string;
  destination?: string;
  tripType?: string;
  segments?: Segment[] | null;
  passengers?: PassengerCounts;
  lowestPrice?: number | null;
  currency?: string | null;
  lastChecked?: string | null;
}

interface OptionComparisonProps {
  trackers: SavedTracker[];
}

function isKnownShape(tripType: string): tripType is SegmentsTripType {
  return tripType === 'round_trip' || tripType === 'open_jaw' || tripType === 'multi_city';
}

function routeLabel(tracker: SavedTracker, entry: ComparisonEntry | undefined): string {
  if (entry?.segments && entry.segments.length > 1) {
    return entry.segments.map((leg) => `${leg.from} → ${leg.to}`).join(', ');
  }
  return `${tracker.origin} → ${tracker.destination}`;
}

function formatDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function OptionComparison({ trackers }: OptionComparisonProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(trackers.map((t) => t.id)));
  const [entries, setEntries] = useState<Record<string, ComparisonEntry>>({});
  const trackerIdsKey = trackers.map((t) => t.id).join(',');

  useEffect(() => {
    let cancelled = false;
    setEntries(Object.fromEntries(trackers.map((t) => [t.id, { status: 'loading' as const }])));

    trackers.forEach(async (tracker) => {
      try {
        const res = await fetch(`/api/queries/${tracker.id}/prices`);
        const data = await res.json();
        if (cancelled) return;
        if (!data.ok) {
          setEntries((prev) => ({ ...prev, [tracker.id]: { status: 'error' } }));
          return;
        }
        const { query, snapshots, lastChecked } = data.data;
        setEntries((prev) => ({
          ...prev,
          [tracker.id]: {
            status: 'ready',
            origin: query.origin,
            destination: query.destination,
            tripType: query.tripType,
            segments: query.segments ?? null,
            passengers: {
              adults: query.adults ?? 1,
              children: query.children ?? 0,
              infantsInSeat: query.infantsInSeat ?? 0,
              infantsOnLap: query.infantsOnLap ?? 0,
            },
            lowestPrice: lowestAvailablePrice(snapshots),
            currency: query.currency,
            lastChecked,
          },
        }));
      } catch {
        if (!cancelled) setEntries((prev) => ({ ...prev, [tracker.id]: { status: 'error' } }));
      }
    });

    return () => {
      cancelled = true;
    };
    // Re-fetching only needs to happen when the tracker id set itself
    // changes, so the effect depends on that derived key rather than the
    // `trackers` array reference (which the caller may recreate on re-render).
  }, [trackerIdsKey]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visible = trackers.filter((t) => selectedIds.has(t.id));
  const cheapestId = visible.reduce<{ id: string | null; price: number }>((best, t) => {
    const price = entries[t.id]?.lowestPrice;
    if (price != null && price < best.price) return { id: t.id, price };
    return best;
  }, { id: null, price: Infinity }).id;

  if (trackers.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No trackers yet. Create a couple of trackers with different route shapes, then come back here to compare their total prices.</p>
        <Link href="/" className={styles.emptyLink}>Back to search</Link>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.pickerRow}>
        {trackers.map((tracker) => (
          <label key={tracker.id} className={styles.pickerItem}>
            <input
              type="checkbox"
              checked={selectedIds.has(tracker.id)}
              onChange={() => toggleSelected(tracker.id)}
            />
            <span>{tracker.label || `${tracker.origin} → ${tracker.destination}`}</span>
          </label>
        ))}
      </div>

      <div className={styles.grid} data-testid="comparison-grid">
        {visible.map((tracker) => {
          const entry = entries[tracker.id];
          const isCheapest = tracker.id === cheapestId;
          return (
            <div
              key={tracker.id}
              className={`${styles.card} ${isCheapest ? styles.cardCheapest : ''}`}
              data-testid={`comparison-card-${tracker.id}`}
            >
              {isCheapest && <span className={styles.cheapestBadge}>Cheapest</span>}
              <div className={styles.route}>{routeLabel(tracker, entry)}</div>
              {entry?.tripType && isKnownShape(entry.tripType) && (
                <span className={styles.shapeBadge}>{tripTypeLabel(entry.tripType)}</span>
              )}
              <div className={styles.dates}>
                {formatDate(tracker.dateFrom)} &ndash; {formatDate(tracker.dateTo)}
              </div>
              {entry?.passengers && passengerSummary(entry.passengers) && (
                <div className={styles.passengers}>{passengerSummary(entry.passengers)}</div>
              )}
              <div className={styles.price}>
                {entry?.status === 'loading' && 'Loading…'}
                {entry?.status === 'error' && 'Unavailable'}
                {entry?.status === 'ready' && entry.lowestPrice == null && 'No price yet'}
                {entry?.status === 'ready' && entry.lowestPrice != null &&
                  `${entry.currency ?? ''} ${entry.lowestPrice.toLocaleString()}`.trim()}
              </div>
              <Link href={`/q/${tracker.id}`} className={styles.viewLink}>View tracker</Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
