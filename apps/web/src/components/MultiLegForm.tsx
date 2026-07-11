'use client';

import { useMemo, useState } from 'react';
import styles from './MultiLegForm.module.css';

export interface Leg {
  from: string;
  to: string;
  date: string;
}

export type TripShape = 'round_trip' | 'open_jaw' | 'multi_city';

/**
 * Derive the trip shape from a list of legs, matching the server's
 * parseSegments and the tfs-builder: a 2-leg trip whose return reverses the
 * outbound is a round trip; a non-reversing 2-leg trip is an open jaw; 3+ legs
 * is multi-city. (Google Flights encodes open-jaw and multi-city identically —
 * see tfs-builder — but the label helps the user understand what they built.)
 */
export function deriveTripShape(legs: Leg[]): TripShape {
  if (legs.length >= 3) return 'multi_city';
  const [out, ret] = legs;
  if (out && ret && out.from === ret.to && out.to === ret.from) return 'round_trip';
  return 'open_jaw';
}

const SHAPE_LABEL: Record<TripShape, string> = {
  round_trip: 'Round trip',
  open_jaw: 'Open jaw (return from a different city)',
  multi_city: 'Multi-city',
};

const IATA = /^[A-Za-z]{3}$/;
const MAX_LEGS = 6;

function normalize(legs: Leg[]): Leg[] {
  return legs.map((l) => ({ from: l.from.trim().toUpperCase(), to: l.to.trim().toUpperCase(), date: l.date }));
}

function legComplete(l: Leg): boolean {
  return IATA.test(l.from.trim()) && IATA.test(l.to.trim()) && /^\d{4}-\d{2}-\d{2}$/.test(l.date);
}

export interface MultiLegFormProps {
  adults?: number;
  children?: number;
  infantsInSeat?: number;
  infantsOnLap?: number;
  /** Called with the created query id(s) after a successful submit. */
  onCreated?: (queryIds: string[]) => void;
}

/**
 * Enter a multi-segment itinerary (open-jaw / multi-city) by adding legs, and
 * create a tracker for it. Round-trip and one-way still have their quick paths
 * in the main search UI; this form covers the non-standard shapes.
 */
export function MultiLegForm({
  adults = 1,
  children = 0,
  infantsInSeat = 0,
  infantsOnLap = 0,
  onCreated,
}: MultiLegFormProps) {
  const [legs, setLegs] = useState<Leg[]>([
    { from: '', to: '', date: '' },
    { from: '', to: '', date: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const shape = useMemo(() => deriveTripShape(normalize(legs)), [legs]);

  const setLeg = (i: number, patch: Partial<Leg>) => {
    setLegs((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setError(null);
  };
  const addLeg = () => {
    setLegs((prev) => (prev.length >= MAX_LEGS ? prev : [...prev, { from: '', to: '', date: '' }]));
  };
  const removeLeg = (i: number) => {
    setLegs((prev) => (prev.length <= 2 ? prev : prev.filter((_, j) => j !== i)));
  };

  const submit = async () => {
    const norm = normalize(legs);
    if (!norm.every(legComplete)) {
      setError('Every leg needs a 3-letter origin, destination, and date.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const origin = norm[0]!.from;
      const destination = norm[0]!.to;
      const res = await fetch('/api/queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawInput: `${origin} to ${destination} ${SHAPE_LABEL[shape]} (${norm.length} legs)`,
          origin,
          originName: origin,
          destination,
          destinationName: destination,
          dateFrom: norm[0]!.date,
          dateTo: norm[norm.length - 1]!.date,
          segments: norm,
          adults,
          children,
          infantsInSeat,
          infantsOnLap,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json?.error ?? `Create failed (HTTP ${res.status})`);
        return;
      }
      const ids: string[] = (json.data?.queries ?? []).map((q: { id: string }) => q.id);
      onCreated?.(ids);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.form}>
      <div className={styles.shape} data-shape={shape}>
        {SHAPE_LABEL[shape]}
      </div>
      {legs.map((leg, i) => (
        <div className={styles.leg} key={i}>
          <span className={styles.legNum}>{i + 1}</span>
          <label className={styles.field}>
            <span className={styles.label}>From</span>
            <input
              className={styles.input}
              value={leg.from}
              maxLength={3}
              placeholder="LAX"
              onChange={(e) => setLeg(i, { from: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>To</span>
            <input
              className={styles.input}
              value={leg.to}
              maxLength={3}
              placeholder="AKL"
              onChange={(e) => setLeg(i, { to: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Date</span>
            <input
              className={styles.input}
              type="date"
              value={leg.date}
              onChange={(e) => setLeg(i, { date: e.target.value })}
            />
          </label>
          {legs.length > 2 && (
            <button type="button" className={styles.remove} onClick={() => removeLeg(i)} aria-label={`Remove leg ${i + 1}`}>
              ×
            </button>
          )}
        </div>
      ))}
      <div className={styles.actions}>
        <button type="button" className={styles.addLeg} onClick={addLeg} disabled={legs.length >= MAX_LEGS}>
          + Add leg
        </button>
        <button type="button" className={styles.submit} onClick={submit} disabled={submitting}>
          {submitting ? 'Creating…' : 'Track this itinerary'}
        </button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
