'use client';

/**
 * /variation — the variation-search page (ticket-tracker-izy).
 *
 * Answers "when should we fly, and where CAN we?" by sweeping a neighbourhood of
 * dates x NZ gateways x route shapes and rendering the price matrix.
 *
 * Defaults are pre-filled with the real trip (LAX -> NZ, holidays 2026-27, 3 adults
 * + 2 children) so the common case is one click.
 */
import { useState } from 'react';
import { VariationHeatmap, type HeatmapCell, type HeatmapCoverage } from '@/components/VariationHeatmap';
import styles from './page.module.css';

const GATEWAYS = ['AKL', 'CHC', 'WLG', 'ZQN'] as const;
const SHAPES = [
  { value: 'round_trip', label: 'Round trip' },
  { value: 'open_jaw', label: 'Open jaw (in one city, out another)' },
  { value: 'two_one_ways', label: 'Two one-ways (availability fallback)' },
] as const;

interface SweepResponse {
  ok: boolean;
  error?: string;
  data?: { cells: HeatmapCell[]; coverage: HeatmapCoverage };
}

export default function VariationPage() {
  const [origin, setOrigin] = useState('LAX');
  const [destinations, setDestinations] = useState<string[]>(['AKL']);
  const [departFrom, setDepartFrom] = useState('2026-12-10');
  const [departTo, setDepartTo] = useState('2026-12-16');
  const [returnFrom, setReturnFrom] = useState('2026-12-29');
  const [returnTo, setReturnTo] = useState('2027-01-05');
  const [minNights, setMinNights] = useState(18);
  const [maxNights, setMaxNights] = useState(24);
  const [shapes, setShapes] = useState<string[]>(['round_trip']);
  const [adults, setAdults] = useState(3);
  const [children, setChildren] = useState(2);
  const [maxCombos, setMaxCombos] = useState(24);
  const [requestBudget, setRequestBudget] = useState(20);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ cells: HeatmapCell[]; coverage: HeatmapCoverage } | null>(null);

  function toggle(list: string[], value: string, set: (v: string[]) => void) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function runSweep(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/variation/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin,
          destinations,
          departWindow: { from: departFrom, to: departTo },
          returnWindow: { from: returnFrom, to: returnTo },
          stayNights: { min: minNights, max: maxNights },
          shapes,
          maxCombos,
          requestBudget,
          adults,
          children,
        }),
      });
      const json = (await res.json()) as SweepResponse;
      if (!json.ok || !json.data) {
        setError(json.error ?? 'Sweep failed');
        setResult(null);
        return;
      }
      setResult(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={styles.root}>
      <h1 className={styles.title}>Variation search</h1>
      <p className={styles.subtitle}>
        Sweep nearby dates, alternate gateways and route shapes to find where you can actually fly —
        and when it&apos;s cheapest. Prices are the total for the whole party.
      </p>

      <form className={styles.form} onSubmit={runSweep}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>From</span>
            <input value={origin} onChange={(e) => setOrigin(e.target.value.toUpperCase())} maxLength={3} />
          </label>

          <fieldset className={styles.group}>
            <legend>Gateways</legend>
            {GATEWAYS.map((g) => (
              <label key={g} className={styles.check}>
                <input
                  type="checkbox"
                  checked={destinations.includes(g)}
                  onChange={() => toggle(destinations, g, setDestinations)}
                />
                {g}
              </label>
            ))}
          </fieldset>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span>Depart between</span>
            <input type="date" value={departFrom} onChange={(e) => setDepartFrom(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>and</span>
            <input type="date" value={departTo} onChange={(e) => setDepartTo(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>Return between</span>
            <input type="date" value={returnFrom} onChange={(e) => setReturnFrom(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>and</span>
            <input type="date" value={returnTo} onChange={(e) => setReturnTo(e.target.value)} />
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span>Stay (nights)</span>
            <input
              type="number"
              min={0}
              max={365}
              value={minNights}
              onChange={(e) => setMinNights(Number(e.target.value))}
            />
          </label>
          <label className={styles.field}>
            <span>to</span>
            <input
              type="number"
              min={0}
              max={365}
              value={maxNights}
              onChange={(e) => setMaxNights(Number(e.target.value))}
            />
          </label>
          <label className={styles.field}>
            <span>Adults</span>
            <input
              type="number"
              min={1}
              max={9}
              value={adults}
              onChange={(e) => setAdults(Number(e.target.value))}
            />
          </label>
          <label className={styles.field}>
            <span>Children</span>
            <input
              type="number"
              min={0}
              max={8}
              value={children}
              onChange={(e) => setChildren(Number(e.target.value))}
            />
          </label>
        </div>

        <fieldset className={styles.group}>
          <legend>Route shapes</legend>
          {SHAPES.map((s) => (
            <label key={s.value} className={styles.check}>
              <input
                type="checkbox"
                checked={shapes.includes(s.value)}
                onChange={() => toggle(shapes, s.value, setShapes)}
              />
              {s.label}
            </label>
          ))}
        </fieldset>

        <div className={styles.row}>
          <label className={styles.field}>
            <span>Max combos</span>
            <input
              type="number"
              min={1}
              max={60}
              value={maxCombos}
              onChange={(e) => setMaxCombos(Number(e.target.value))}
            />
          </label>
          <label className={styles.field}>
            <span>Request budget</span>
            <input
              type="number"
              min={1}
              max={40}
              value={requestBudget}
              onChange={(e) => setRequestBudget(Number(e.target.value))}
            />
          </label>
          <button className={styles.submit} type="submit" disabled={loading || shapes.length === 0}>
            {loading ? 'Sweeping…' : 'Run sweep'}
          </button>
        </div>
        <p className={styles.hint}>
          Each combination is a real Google query — the budget caps how many run, and the results say
          how much of the grid was actually covered.
        </p>
      </form>

      {error && <p className={styles.error}>{error}</p>}

      {result && <VariationHeatmap cells={result.cells} coverage={result.coverage} />}
    </main>
  );
}
