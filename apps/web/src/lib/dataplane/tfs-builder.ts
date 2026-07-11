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

export type TfsTrip = 'round-trip' | 'one-way';
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

/** Build the base64 `tfs` parameter value for a query. */
export function buildTfs(query: TfsQuery): string {
  const expectedSegments = query.trip === 'round-trip' ? 2 : 1;
  if (query.segments.length !== expectedSegments) {
    throw new Error(
      `${query.trip} requires exactly ${expectedSegments} segment(s), got ${query.segments.length}`,
    );
  }
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
