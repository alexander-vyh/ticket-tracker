/**
 * Client-safe helpers for multi-leg itinerary entry (open-jaw / multi-city).
 * Mirrors the trip-shape rule enforced server-side in
 * apps/web/src/app/api/queries/route.ts (parseSegments): keep the two in
 * sync if Google's shape semantics ever change.
 */

export interface SegmentLegInput {
  from: string;
  to: string;
  date: string;
}

export type SegmentsTripType = 'round_trip' | 'open_jaw' | 'multi_city';

const IATA = /^[A-Za-z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Derives the itinerary shape from an ordered list of legs: two legs whose
 * return reverses the outbound pair are a round trip, two legs that don't
 * reverse are an open-jaw, and three or more legs are always multi-city.
 */
export function deriveSegmentsTripType(legs: Array<{ from: string; to: string }>): SegmentsTripType {
  if (legs.length === 2) {
    const [out, ret] = legs;
    const reverses =
      out!.from.toUpperCase() === ret!.to.toUpperCase() &&
      out!.to.toUpperCase() === ret!.from.toUpperCase();
    return reverses ? 'round_trip' : 'open_jaw';
  }
  return 'multi_city';
}

export function tripTypeLabel(tripType: SegmentsTripType): string {
  switch (tripType) {
    case 'round_trip':
      return 'Round trip';
    case 'open_jaw':
      return 'Open jaw';
    case 'multi_city':
      return 'Multi-city';
  }
}

/**
 * Field-level validation for a leg row. Returns an empty object when the leg
 * is valid. `prevDate` enforces chronological order against the previous leg
 * (not required by the API, but a leg dated before the one it follows is
 * never a real itinerary).
 */
export function validateLeg(
  leg: { from: string; to: string; date: string },
  prevDate: string | null,
): { from?: string; to?: string; date?: string } {
  const errors: { from?: string; to?: string; date?: string } = {};
  if (!leg.from || !IATA.test(leg.from)) errors.from = 'Select an airport';
  if (!leg.to || !IATA.test(leg.to)) errors.to = 'Select an airport';
  if (
    leg.from &&
    leg.to &&
    IATA.test(leg.from) &&
    IATA.test(leg.to) &&
    leg.from.toUpperCase() === leg.to.toUpperCase()
  ) {
    errors.to = 'Must differ from origin';
  }
  if (!leg.date || !ISO_DATE.test(leg.date)) {
    errors.date = 'Select a date';
  } else if (prevDate && leg.date < prevDate) {
    errors.date = 'Must be on or after the previous leg';
  }
  return errors;
}
