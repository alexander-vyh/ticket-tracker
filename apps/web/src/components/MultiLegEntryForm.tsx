'use client';

import { useState } from 'react';
import { AirportCombobox } from './AirportCombobox';
import type { CreatedTracker } from './LinkBanner';
import { detectLocaleCurrency } from '@/lib/currency';
import { deriveSegmentsTripType, tripTypeLabel, validateLeg, type SegmentsTripType } from '@/lib/segments';
import styles from './MultiLegEntryForm.module.css';

const MIN_LEGS = 2;
const MAX_LEGS = 6;

interface SelectedAirport {
  code: string;
  name: string;
}

interface LegState {
  origin: SelectedAirport | null;
  destination: SelectedAirport | null;
  date: string;
}

// The /api/queries POST response includes deleteToken/label alongside the
// CreatedTracker fields LinkBanner displays; the caller needs the former to
// persist the tracker locally (see tracker-storage.addSavedTracker).
export interface CreatedSegmentQuery extends CreatedTracker {
  deleteToken: string;
  label: string | null;
}

interface MultiLegEntryFormProps {
  // dateFrom/dateTo are the first/last leg dates the form already knows —
  // the /api/queries response only echoes a per-route `date` for the
  // `routes` array request format, not for this origin/destination +
  // segments format, so the caller must not rely on the response for these.
  onCreated: (queries: CreatedSegmentQuery[], tripType: SegmentsTripType, dateFrom: string, dateTo: string) => void;
  onCancel: () => void;
  adminCurrency: string | null;
  cancelLabel?: string;
}

function emptyLeg(): LegState {
  return { origin: null, destination: null, date: '' };
}

function synthesizeRawInput(legs: LegState[], tripType: SegmentsTripType): string {
  const parts = legs.map((leg) => `${leg.origin!.code} to ${leg.destination!.code} ${leg.date}`);
  return `${parts.join(', ')} (${tripTypeLabel(tripType).toLowerCase()})`;
}

export function MultiLegEntryForm({ onCreated, onCancel, adminCurrency, cancelLabel = 'Cancel' }: MultiLegEntryFormProps) {
  const [legs, setLegs] = useState<LegState[]>([emptyLeg(), emptyLeg()]);
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [infantsInSeat, setInfantsInSeat] = useState(0);
  const [infantsOnLap, setInfantsOnLap] = useState(0);
  // Off by default: deep search forces the browser+LLM tier on every scrape of
  // this tracker, which is the expensive path. (ticket-tracker-gvh)
  const [deepSearch, setDeepSearch] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const derivedTripType: SegmentsTripType | null =
    legs.every((l) => l.origin && l.destination) ? deriveSegmentsTripType(
      legs.map((l) => ({ from: l.origin!.code, to: l.destination!.code })),
    ) : null;

  const updateLeg = (index: number, patch: Partial<LegState>) => {
    setLegs((prev) => prev.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)));
    setFieldErrors((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch)) delete next[`leg-${index}-${key}`];
      return next;
    });
  };

  const addLeg = () => {
    if (legs.length >= MAX_LEGS) return;
    const last = legs[legs.length - 1]!;
    setLegs((prev) => [...prev, { origin: last.destination, destination: null, date: '' }]);
  };

  const removeLeg = (index: number) => {
    if (legs.length <= MIN_LEGS) return;
    setLegs((prev) => prev.filter((_, i) => i !== index));
  };

  const validate = (): Record<string, string> | null => {
    const errors: Record<string, string> = {};
    let prevDate: string | null = null;
    legs.forEach((leg, i) => {
      const legErrors = validateLeg(
        { from: leg.origin?.code ?? '', to: leg.destination?.code ?? '', date: leg.date },
        prevDate,
      );
      for (const [field, message] of Object.entries(legErrors)) {
        errors[`leg-${i}-${field}`] = message!;
      }
      if (leg.date) prevDate = leg.date;
    });
    const totalPax = adults + children + infantsInSeat + infantsOnLap;
    if (totalPax > 9) errors.passengers = 'Google Flights supports at most 9 passengers';
    if (infantsOnLap > adults) errors.passengers = 'Each infant on lap requires an adult';
    return Object.keys(errors).length > 0 ? errors : null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors = validate();
    if (errors) {
      setFieldErrors(errors);
      return;
    }

    const tripType = deriveSegmentsTripType(legs.map((l) => ({ from: l.origin!.code, to: l.destination!.code })));
    const segments = legs.map((l) => ({ from: l.origin!.code, to: l.destination!.code, date: l.date }));
    const rawInput = synthesizeRawInput(legs, tripType);

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawInput,
          // /api/queries requires origin/destination (or a routes array) on
          // every request, independent of segments — segments only override
          // the persisted trip shape, they don't replace this legacy pair.
          origin: legs[0]!.origin!.code,
          originName: legs[0]!.origin!.name,
          destination: legs[legs.length - 1]!.destination!.code,
          destinationName: legs[legs.length - 1]!.destination!.name,
          dateFrom: legs[0]!.date,
          dateTo: legs[legs.length - 1]!.date,
          tripType: 'multi_city',
          segments,
          adults,
          children,
          infantsInSeat,
          infantsOnLap,
          deepSearch,
          currency: adminCurrency || detectLocaleCurrency(),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSubmitError(data.error || 'Failed to create tracker');
        return;
      }
      onCreated(data.data.queries as CreatedSegmentQuery[], tripType, legs[0]!.date, legs[legs.length - 1]!.date);
    } catch {
      setSubmitError('Network error - please try again');
    } finally {
      setSubmitting(false);
    }
  };

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return (
    <form className={styles.root} onSubmit={handleSubmit} noValidate>
      <div className={styles.header}>
        <span className={styles.sectionLabel}>Multi-leg itinerary</span>
        {derivedTripType && (
          <span className={styles.shapeBadge} data-testid="derived-trip-type">
            {tripTypeLabel(derivedTripType)}
          </span>
        )}
      </div>

      {legs.map((leg, i) => (
        <div key={i} className={styles.legRow} data-testid={`leg-${i}`}>
          <span className={styles.legNumber}>{i + 1}</span>
          <AirportCombobox
            id={`leg-${i}-from`}
            label={i === 0 ? 'Origin' : `Leg ${i + 1} origin`}
            placeholder="From"
            value={leg.origin}
            onChange={(v) => updateLeg(i, { origin: v })}
            error={fieldErrors[`leg-${i}-from`]}
            excludeCode={leg.destination?.code}
          />
          <AirportCombobox
            id={`leg-${i}-to`}
            label={i === legs.length - 1 ? 'Final destination' : `Leg ${i + 1} destination`}
            placeholder="To"
            value={leg.destination}
            onChange={(v) => updateLeg(i, { destination: v })}
            error={fieldErrors[`leg-${i}-to`]}
            excludeCode={leg.origin?.code}
          />
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`leg-${i}-date`}>Date</label>
            <input
              id={`leg-${i}-date`}
              className={`${styles.input} ${fieldErrors[`leg-${i}-date`] ? styles.inputError : ''}`}
              type="date"
              min={today}
              value={leg.date}
              onChange={(e) => updateLeg(i, { date: e.target.value })}
              aria-invalid={!!fieldErrors[`leg-${i}-date`]}
            />
            {fieldErrors[`leg-${i}-date`] && <span className={styles.errorText}>{fieldErrors[`leg-${i}-date`]}</span>}
          </div>
          {legs.length > MIN_LEGS && (
            <button
              type="button"
              className={styles.removeLeg}
              onClick={() => removeLeg(i)}
              aria-label={`Remove leg ${i + 1}`}
            >
              &times;
            </button>
          )}
        </div>
      ))}

      <button
        type="button"
        className={styles.addLeg}
        onClick={addLeg}
        disabled={legs.length >= MAX_LEGS}
      >
        + Add leg
      </button>

      <div className={styles.sectionLabel}>Passengers</div>
      <div className={styles.fieldRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ml-adults">Adults</label>
          <input
            id="ml-adults"
            className={styles.input}
            type="number"
            min={1}
            max={9}
            value={adults}
            onChange={(e) => setAdults(Math.max(1, Math.min(9, parseInt(e.target.value, 10) || 1)))}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ml-children">Children</label>
          <input
            id="ml-children"
            className={styles.input}
            type="number"
            min={0}
            max={8}
            value={children}
            onChange={(e) => setChildren(Math.max(0, Math.min(8, parseInt(e.target.value, 10) || 0)))}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ml-infants-seat">Infants (seat)</label>
          <input
            id="ml-infants-seat"
            className={styles.input}
            type="number"
            min={0}
            max={8}
            value={infantsInSeat}
            onChange={(e) => setInfantsInSeat(Math.max(0, Math.min(8, parseInt(e.target.value, 10) || 0)))}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ml-infants-lap">Infants (lap)</label>
          <input
            id="ml-infants-lap"
            className={styles.input}
            type="number"
            min={0}
            max={8}
            value={infantsOnLap}
            onChange={(e) => setInfantsOnLap(Math.max(0, Math.min(8, parseInt(e.target.value, 10) || 0)))}
          />
        </div>
      </div>
      {fieldErrors.passengers && <span className={styles.errorText}>{fieldErrors.passengers}</span>}

      <div className={styles.checkboxRow}>
        <input
          id="ml-deep-search"
          className={styles.checkbox}
          type="checkbox"
          checked={deepSearch}
          onChange={(e) => setDeepSearch(e.target.checked)}
        />
        <label className={styles.checkboxLabel} htmlFor="ml-deep-search">
          Deep search
          <span className={styles.checkboxHint}>
            Reads the full carrier list instead of Google&apos;s top-5 &ldquo;best&rdquo; flights, which
            hides cheaper one-stop routings. Slower and costs more per check. Trips with
            children always use the full list.
          </span>
        </label>
      </div>

      {submitError && <div className={styles.errorText}>{submitError}</div>}

      <div className={styles.actions}>
        <button type="submit" className={styles.submitButton} disabled={submitting}>
          {submitting ? 'Creating…' : 'Create tracker'}
        </button>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </form>
  );
}
