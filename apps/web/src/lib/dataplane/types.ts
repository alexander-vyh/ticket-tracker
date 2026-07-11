/** Shared types for the Google Flights data plane (tier 1 SSR + tier 2 browser). */

export interface DataplaneLeg {
  fromAirport: string;
  fromAirportName: string | null;
  toAirport: string;
  toAirportName: string | null;
  /** [year, month, day] as Google returns it */
  departureDate: number[] | null;
  /** [hour, minute?] — minute omitted when zero; entries may be null */
  departureTime: (number | null)[] | null;
  arrivalDate: number[] | null;
  arrivalTime: (number | null)[] | null;
  /** minutes */
  duration: number | null;
  planeType: string | null;
}

export interface DataplaneFlight {
  /** total itinerary price for ALL passengers, in the requested currency */
  price: number;
  airlines: string[];
  legs: DataplaneLeg[];
}

/**
 * Tier-1 SSR outcome. `deferred` is a first-class state, NOT an error and NOT
 * an empty result: Google omitted results from the server-rendered payload and
 * loads them client-side (measured on every children>0 query and some heavy
 * queries, 2026-07-10). A deferred query must be retried on tier 2 (browser);
 * recording it as "no flights" corrupts availability history.
 */
export type SsrParseResult =
  | { status: 'ok'; flights: DataplaneFlight[] }
  | { status: 'deferred' }
  | { status: 'error'; reason: string };
