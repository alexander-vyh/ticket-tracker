/**
 * Google Flights `tfs` query-parameter builder.
 *
 * Ported from fast-flights' (AWeirdDev/flights, MIT) reverse-engineered
 * protobuf schema and byte-verified against Google Flights' own rendering
 * (see tfs-builder.test.ts golden strings). The wire format is small enough
 * that we hand-roll proto3 encoding rather than take a protobuf dependency:
 *
 *   Info {                       FlightData {
 *     repeated FlightData data = 3;   string date = 2;
 *     repeated Passenger passengers = 8; // packed  optional int32 max_stops = 5;
 *     Seat seat = 9;                  repeated string airlines = 6;
 *     Trip trip = 19;                 Airport from_airport = 13; // { airport = 2 }
 *   }                               Airport to_airport = 14;   // { airport = 2 }
 *                                 }
 */

export interface TfsSegment {
  /** ISO date, e.g. '2026-12-18' */
  date: string;
  /** IATA code, e.g. 'LAX' */
  fromAirport: string;
  toAirport: string;
  maxStops?: number;
  airlines?: string[];
}

export interface TfsPassengers {
  adults?: number;
  children?: number;
  infantsInSeat?: number;
  infantsOnLap?: number;
}

// 'open-jaw' is a two-segment itinerary whose return does not reverse the
// outbound (e.g. LAX→AKL then CHC→LAX). On the wire Google treats it as a
// multi-city itinerary (trip enum 3), same as 'multi-city' with N segments —
// the distinct name exists only so callers/UI can label the common 2-leg case.
export type TfsTrip = 'round-trip' | 'one-way' | 'open-jaw' | 'multi-city';
export type TfsSeat = 'economy' | 'premium-economy' | 'business' | 'first';

export interface TfsQuery {
  trip: TfsTrip;
  seat: TfsSeat;
  segments: TfsSegment[];
  passengers: TfsPassengers;
}

const SEAT_ENUM: Record<TfsSeat, number> = {
  economy: 1,
  'premium-economy': 2,
  business: 3,
  first: 4,
};

const TRIP_ENUM: Record<TfsTrip, number> = {
  'round-trip': 1,
  'one-way': 2,
  'open-jaw': 3, // Google Trip.MULTI_CITY — an open-jaw is a 2-leg multi-city
  'multi-city': 3,
};

const PASSENGER_ENUM = { adult: 1, child: 2, infantInSeat: 3, infantOnLap: 4 } as const;

const MAX_TOTAL_PASSENGERS = 9; // Google Flights hard limit

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

/** Tag = (fieldNumber << 3) | wireType, itself varint-encoded. */
function tag(field: number, wireType: 0 | 2): number[] {
  return varint((field << 3) | wireType);
}

function lenDelimited(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}

function stringField(field: number, value: string): number[] {
  return lenDelimited(field, [...Buffer.from(value, 'utf8')]);
}

function varintField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}

function encodeAirport(iata: string): number[] {
  return [...stringField(2, iata)];
}

function encodeSegment(seg: TfsSegment): number[] {
  const bytes: number[] = [...stringField(2, seg.date)];
  if (seg.maxStops !== undefined) bytes.push(...varintField(5, seg.maxStops));
  for (const airline of seg.airlines ?? []) bytes.push(...stringField(6, airline));
  bytes.push(...lenDelimited(13, encodeAirport(seg.fromAirport)));
  bytes.push(...lenDelimited(14, encodeAirport(seg.toAirport)));
  return bytes;
}

function passengerList(p: TfsPassengers): number[] {
  const adults = p.adults ?? 0;
  const children = p.children ?? 0;
  const infantsInSeat = p.infantsInSeat ?? 0;
  const infantsOnLap = p.infantsOnLap ?? 0;
  const total = adults + children + infantsInSeat + infantsOnLap;
  if (total < 1 || total > MAX_TOTAL_PASSENGERS) {
    throw new Error(`Passenger count must be 1-${MAX_TOTAL_PASSENGERS}, got ${total}`);
  }
  if (infantsOnLap > adults) {
    throw new Error('Each infant on lap requires an adult (infantsOnLap > adults)');
  }
  return [
    ...Array(adults).fill(PASSENGER_ENUM.adult),
    ...Array(children).fill(PASSENGER_ENUM.child),
    ...Array(infantsInSeat).fill(PASSENGER_ENUM.infantInSeat),
    ...Array(infantsOnLap).fill(PASSENGER_ENUM.infantOnLap),
  ];
}

/**
 * Enforce Google's segment-count rules per trip type: one-way = exactly 1,
 * round-trip = exactly 2 (and the return must reverse the outbound — a
 * non-reversing 2-leg trip is an open-jaw, not a round-trip), open-jaw =
 * exactly 2, multi-city = 2 or more.
 */
function validateSegmentCount(query: TfsQuery): void {
  const n = query.segments.length;
  switch (query.trip) {
    case 'one-way':
      if (n !== 1) throw new Error(`one-way requires exactly 1 segment, got ${n}`);
      return;
    case 'round-trip': {
      if (n !== 2) throw new Error(`round-trip requires exactly 2 segments, got ${n}`);
      const [out, ret] = query.segments;
      if (out!.fromAirport !== ret!.toAirport || out!.toAirport !== ret!.fromAirport) {
        throw new Error(
          'round-trip return must reverse the outbound (same city pair); ' +
            "use trip 'open-jaw' for a return from/to a different airport",
        );
      }
      return;
    }
    case 'open-jaw':
      if (n !== 2) throw new Error(`open-jaw requires exactly 2 segments, got ${n}`);
      return;
    case 'multi-city':
      if (n < 2) throw new Error(`multi-city requires at least 2 segments, got ${n}`);
      return;
  }
}

/** Build the base64 `tfs` parameter value for a query. */
export function buildTfs(query: TfsQuery): string {
  validateSegmentCount(query);
  const bytes: number[] = [];
  for (const seg of query.segments) bytes.push(...lenDelimited(3, encodeSegment(seg)));
  bytes.push(...lenDelimited(8, passengerList(query.passengers))); // packed enums
  bytes.push(...varintField(9, SEAT_ENUM[query.seat]));
  bytes.push(...varintField(19, TRIP_ENUM[query.trip]));
  return Buffer.from(bytes).toString('base64');
}

export interface TfsUrlOptions {
  hl?: string;
  gl?: string;
  curr?: string;
}

/** Full Google Flights search URL for a query. */
export function buildTfsUrl(query: TfsQuery, opts: TfsUrlOptions = {}): string {
  const params = new URLSearchParams();
  params.set('tfs', buildTfs(query));
  params.set('hl', opts.hl ?? 'en');
  params.set('gl', opts.gl ?? 'US');
  params.set('curr', opts.curr ?? 'USD');
  return `https://www.google.com/travel/flights/search?${params.toString()}`;
}
