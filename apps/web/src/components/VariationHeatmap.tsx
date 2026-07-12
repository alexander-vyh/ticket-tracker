'use client';

/**
 * Price heatmap for the variation sweep (ticket-tracker-izy).
 *
 * Rows = departure date, columns = return date, cell = the CHEAPEST bookable
 * itinerary for that date pair (across gateways and route shapes). Answers the
 * product's real question at a glance: "when should we fly, and where CAN we?"
 *
 * Encoding decisions that matter:
 *  - Price is a MAGNITUDE, so it gets a sequential one-hue ramp (blue), bucketed
 *    across the sweep's own min..max. Monotonic in lightness, validated.
 *  - Sold-out / throttled / unpriced are NOT magnitudes and never take a ramp
 *    step. A pale ramp step means "cheap"; painting an unbookable date that way
 *    would make it look like the bargain of the sweep. They get a neutral fill
 *    plus a GLYPH AND LABEL, so state is never carried by colour alone.
 *  - The cheapest cell is MARKED (ring + tag), not recoloured — recolouring it
 *    would break the ramp it belongs to.
 *  - It is rendered as a real <table> with scope'd headers, so the "table view"
 *    accessibility requirement is satisfied by the chart itself, not a duplicate.
 */
import { useState } from 'react';
import styles from './VariationHeatmap.module.css';

export type CellAvailability = 'available' | 'no_options' | 'throttled';

export interface HeatmapCell {
  candidate: {
    id: string;
    shape: string;
    outbound: { from: string; to: string; date: string };
    inbound: { from: string; to: string; date: string };
    stayNights: number;
  };
  total: number | null;
  currency: string | null;
  availability: CellAvailability;
}

export interface HeatmapCoverage {
  priced: number;
  totalBeforeCap: number;
  droppedByCap: number;
  skippedForBudget: number;
  complete: boolean;
}

export interface VariationHeatmapProps {
  cells: HeatmapCell[];
  coverage?: HeatmapCoverage;
}

const SHAPE_LABEL: Record<string, string> = {
  round_trip: 'Round trip',
  open_jaw: 'Open jaw',
  two_one_ways: 'Two one-ways',
};

function money(n: number, currency: string | null): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency ?? 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

/** "Dec 13" — the year is implied by the sweep window and would just add noise. */
function shortDay(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Reduce the sweep to one cell per (depart, return) coordinate, keeping the
 * CHEAPEST bookable option. A bookable cell always beats an unbookable one, so a
 * sold-out open-jaw can never hide a priced round trip for the same dates.
 */
function bestPerCoordinate(cells: HeatmapCell[]): Map<string, HeatmapCell> {
  const byCoord = new Map<string, HeatmapCell>();
  for (const cell of cells) {
    const key = `${cell.candidate.outbound.date}|${cell.candidate.inbound.date}`;
    const held = byCoord.get(key);
    if (!held) {
      byCoord.set(key, cell);
      continue;
    }
    const heldPriced = held.total != null;
    const cellPriced = cell.total != null;
    if (cellPriced && !heldPriced) byCoord.set(key, cell);
    else if (cellPriced && heldPriced && cell.total! < held.total!) byCoord.set(key, cell);
  }
  return byCoord;
}

/** Bucket a price into 1..6 across the sweep's own range (1 = cheapest). */
function bucketFor(total: number, min: number, max: number): number {
  if (max <= min) return 1; // every bookable cell costs the same
  const t = (total - min) / (max - min);
  return Math.min(6, Math.max(1, Math.floor(t * 6) + 1));
}

export function VariationHeatmap({ cells, coverage }: VariationHeatmapProps): React.ReactElement {
  const [hover, setHover] = useState<{ cell: HeatmapCell; x: number; y: number } | null>(null);

  if (cells.length === 0) {
    return <p className={styles.empty}>No itineraries were priced in this sweep.</p>;
  }

  const byCoord = bestPerCoordinate(cells);
  const departs = [...new Set(cells.map((c) => c.candidate.outbound.date))].sort();
  const returns = [...new Set(cells.map((c) => c.candidate.inbound.date))].sort();

  const priced = [...byCoord.values()].filter((c) => c.total != null && c.availability === 'available');
  const totals = priced.map((c) => c.total!);
  const min = totals.length ? Math.min(...totals) : 0;
  const max = totals.length ? Math.max(...totals) : 0;
  const best = priced.find((c) => c.total === min) ?? null;
  const currency = priced[0]?.currency ?? cells[0]?.currency ?? 'USD';

  return (
    <div className={styles.root}>
      {/* Hero: the one number the whole sweep exists to produce. */}
      {best ? (
        <div className={styles.hero}>
          <span className={styles.heroValue}>{money(min, currency)}</span>
          <span className={styles.heroLabel}>
            cheapest — {SHAPE_LABEL[best.candidate.shape] ?? best.candidate.shape} via{' '}
            {best.candidate.outbound.to}, {shortDay(best.candidate.outbound.date)} →{' '}
            {shortDay(best.candidate.inbound.date)} ({best.candidate.stayNights} nights)
          </span>
        </div>
      ) : (
        <p className={styles.heroNone}>No bookable itinerary found in this sweep.</p>
      )}

      {coverage && (
        <p className={styles.coverage}>
          Priced {coverage.priced} of {coverage.totalBeforeCap} combinations.{' '}
          {coverage.complete ? (
            <span>Complete sweep.</span>
          ) : (
            <span className={styles.incomplete}>
              Partial sweep — {coverage.droppedByCap} dropped by the grid cap,{' '}
              {coverage.skippedForBudget} left unpriced by the request budget.
            </span>
          )}
        </p>
      )}

      <div className={styles.scroll}>
        <table className={styles.table}>
          <caption className="sr-only">
            Cheapest total price for the whole party by departure date (rows) and return date
            (columns).
          </caption>
          <thead>
            <tr>
              <th className={styles.corner} scope="col">
                Out ↓ / Back →
              </th>
              {returns.map((r) => (
                <th key={r} className={styles.colHead} scope="col">
                  {shortDay(r)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {departs.map((d) => (
              <tr key={d}>
                <th className={styles.rowHead} scope="row">
                  {shortDay(d)}
                </th>
                {returns.map((r) => {
                  const cell = byCoord.get(`${d}|${r}`);

                  // Not in the grid at all (stay-length filter excluded this pair).
                  if (!cell) {
                    return (
                      <td
                        key={r}
                        className={`${styles.cell} ${styles.unpriced}`}
                        aria-label={`${shortDay(d)} to ${shortDay(r)}: not searched`}
                      >
                        –
                      </td>
                    );
                  }

                  const isBest = best != null && cell.candidate.id === best.candidate.id;
                  const onEnter = (e: React.MouseEvent) =>
                    setHover({ cell, x: e.clientX, y: e.clientY });

                  // Non-magnitude states: glyph + label, never a ramp step.
                  if (cell.availability !== 'available' || cell.total == null) {
                    const soldOut = cell.availability === 'no_options';
                    const label = soldOut ? 'Sold out' : 'Not checked';
                    return (
                      <td
                        key={r}
                        tabIndex={0}
                        className={`${styles.cell} ${soldOut ? styles.soldOut : styles.throttled}`}
                        onMouseEnter={onEnter}
                        onMouseLeave={() => setHover(null)}
                        onFocus={(e) =>
                          setHover({
                            cell,
                            x: e.currentTarget.getBoundingClientRect().left,
                            y: e.currentTarget.getBoundingClientRect().top,
                          })
                        }
                        onBlur={() => setHover(null)}
                        aria-label={`${shortDay(d)} to ${shortDay(r)}: ${label}`}
                      >
                        {soldOut ? '✕' : '?'}
                      </td>
                    );
                  }

                  const bucket = bucketFor(cell.total, min, max);
                  return (
                    <td
                      key={r}
                      tabIndex={0}
                      className={`${styles.cell} ${styles[`b${bucket}`]} ${isBest ? styles.best : ''}`}
                      onMouseEnter={onEnter}
                      onMouseLeave={() => setHover(null)}
                      onFocus={(e) =>
                        setHover({
                          cell,
                          x: e.currentTarget.getBoundingClientRect().left,
                          y: e.currentTarget.getBoundingClientRect().top,
                        })
                      }
                      onBlur={() => setHover(null)}
                      aria-label={`${shortDay(d)} to ${shortDay(r)}: ${money(cell.total, cell.currency)}${isBest ? ', cheapest' : ''}`}
                    >
                      {money(cell.total, cell.currency)}
                      {isBest && <span className={styles.bestTag}>best</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend is always present — identity is never colour-alone. */}
      <div className={styles.legend}>
        <span className={styles.rampLegend}>
          <span>{totals.length ? money(min, currency) : 'cheaper'}</span>
          <span className={styles.rampSwatches} aria-hidden="true">
            {[1, 2, 3, 4, 5, 6].map((b) => (
              <span key={b} className={`${styles.swatch} ${styles[`b${b}`]}`} />
            ))}
          </span>
          <span>{totals.length ? money(max, currency) : 'dearer'}</span>
        </span>
        <span className={styles.stateKey}>
          <span className={`${styles.stateSwatch} ${styles.soldOut}`} aria-hidden="true">
            ✕
          </span>
          Sold out
        </span>
        <span className={styles.stateKey}>
          <span className={`${styles.stateSwatch} ${styles.throttled}`} aria-hidden="true">
            ?
          </span>
          Not checked
        </span>
        <span className={styles.stateKey}>
          <span className={`${styles.stateSwatch} ${styles.unpriced}`} aria-hidden="true" />
          Not searched
        </span>
      </div>

      {hover && (
        <div
          className={styles.tooltip}
          role="tooltip"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className={styles.tooltipPrice}>
            {hover.cell.total != null && hover.cell.availability === 'available'
              ? money(hover.cell.total, hover.cell.currency)
              : hover.cell.availability === 'no_options'
                ? 'Sold out'
                : 'Not checked (throttled)'}
          </div>
          <div>
            {hover.cell.candidate.outbound.from} → {hover.cell.candidate.outbound.to} ·{' '}
            {shortDay(hover.cell.candidate.outbound.date)}
          </div>
          <div>
            {hover.cell.candidate.inbound.from} → {hover.cell.candidate.inbound.to} ·{' '}
            {shortDay(hover.cell.candidate.inbound.date)}
          </div>
          <div className={styles.tooltipMuted}>
            {SHAPE_LABEL[hover.cell.candidate.shape] ?? hover.cell.candidate.shape} ·{' '}
            {hover.cell.candidate.stayNights} nights
          </div>
        </div>
      )}
    </div>
  );
}
