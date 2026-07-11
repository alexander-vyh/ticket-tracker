import { describe, expect, it } from 'vitest';
import { buildTfs, type TfsQuery } from './tfs-builder';

// oracle: open-jaw and multi-city are encoded as Google Trip.MULTI_CITY (enum 3)
// with one FlightData segment per leg — the same wire shape Google's own
// multi-city UI produces. These tests assert that independent structure by
// DECODING the produced protobuf (field tags + varints per the proto3 spec),
// not by echoing the encoder. The golden-string equality locks the exact bytes
// the encoder emits today; the route's live correctness (Google renders
// LAX→AKL outbound + CHC→LAX return) is browser-verified separately, since
// Google defers multi-city results out of the SSR payload.

const OPEN_JAW: TfsQuery = {
  trip: 'open-jaw',
  seat: 'economy',
  segments: [
    { date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2027-01-08', fromAirport: 'CHC', toAirport: 'LAX' },
  ],
  passengers: { adults: 2 },
};

const MULTI_CITY: TfsQuery = {
  trip: 'multi-city',
  seat: 'economy',
  segments: [
    { date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2026-12-28', fromAirport: 'AKL', toAirport: 'SYD' },
    { date: '2027-01-08', fromAirport: 'SYD', toAirport: 'LAX' },
  ],
  passengers: { adults: 2 },
};

/** Decode just enough of the tfs protobuf to assert structure independently. */
function decode(tfs: string): { segmentCount: number; tripEnum: number | null; airportCodes: string[] } {
  const buf = Buffer.from(tfs, 'base64');
  let i = 0;
  let segmentCount = 0;
  let tripEnum: number | null = null;
  const airportCodes: string[] = [];
  const readVarint = (): number => {
    let shift = 0;
    let v = 0;
    while (i < buf.length) {
      const b = buf[i++]!;
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return v >>> 0;
  };
  while (i < buf.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (wire === 0) {
      const v = readVarint();
      if (field === 19) tripEnum = v; // Info.trip
    } else if (wire === 2) {
      const len = readVarint();
      const chunk = buf.subarray(i, i + len);
      i += len;
      if (field === 3) {
        segmentCount += 1; // Info.data (a FlightData segment)
        // pull 3-letter airport codes out of the nested Airport messages
        const s = chunk.toString('latin1');
        for (const m of s.matchAll(/[A-Z]{3}/g)) airportCodes.push(m[0]);
      }
    }
  }
  return { segmentCount, tripEnum, airportCodes };
}

describe('open-jaw encoding', () => {
  it('encodes two segments with the multi-city trip enum (3), not round-trip (1)', () => {
    const d = decode(buildTfs(OPEN_JAW));
    expect(d.segmentCount).toBe(2);
    expect(d.tripEnum).toBe(3);
  });

  it('preserves the DIFFERENT return origin (CHC), proving it is not a round trip', () => {
    // A round trip of LAX↔AKL would never contain CHC; its presence is the
    // signature of a genuine open jaw.
    const d = decode(buildTfs(OPEN_JAW));
    expect(d.airportCodes).toContain('CHC');
    expect(d.airportCodes).toContain('AKL');
    expect(d.airportCodes).toContain('LAX');
  });

  it('golden byte-string (regression lock; browser-verified against Google separately)', () => {
    expect(buildTfs(OPEN_JAW)).toBe(
      'GhoSCjIwMjYtMTItMThqBRIDTEFYcgUSA0FLTBoaEgoyMDI3LTAxLTA4agUSA0NIQ3IFEgNMQVhCAgEBSAGYAQM=',
    );
  });
});

describe('multi-city encoding', () => {
  it('encodes all three legs under the multi-city trip enum', () => {
    const d = decode(buildTfs(MULTI_CITY));
    expect(d.segmentCount).toBe(3);
    expect(d.tripEnum).toBe(3);
    expect(d.airportCodes).toContain('SYD');
  });

  it('golden byte-string (regression lock)', () => {
    expect(buildTfs(MULTI_CITY)).toBe(
      'GhoSCjIwMjYtMTItMThqBRIDTEFYcgUSA0FLTBoaEgoyMDI2LTEyLTI4agUSA0FLTHIFEgNTWUQaGhIKMjAyNy0wMS0wOGoFEgNTWURyBRIDTEFYQgIBAUgBmAED',
    );
  });
});

describe('segment-count and shape validation', () => {
  it('rejects a round-trip whose return does not reverse the outbound (that is an open jaw)', () => {
    expect(() =>
      buildTfs({ ...OPEN_JAW, trip: 'round-trip' }),
    ).toThrow(/reverse the outbound|open-jaw/i);
  });

  it('still accepts a genuine reversing round-trip', () => {
    expect(() =>
      buildTfs({
        trip: 'round-trip',
        seat: 'economy',
        segments: [
          { date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' },
          { date: '2027-01-08', fromAirport: 'AKL', toAirport: 'LAX' },
        ],
        passengers: { adults: 2 },
      }),
    ).not.toThrow();
  });

  it('rejects open-jaw without exactly two segments', () => {
    expect(() => buildTfs({ ...OPEN_JAW, segments: [OPEN_JAW.segments[0]!] })).toThrow(/2 segment/);
  });

  it('rejects multi-city with fewer than two segments', () => {
    expect(() =>
      buildTfs({ ...MULTI_CITY, segments: [MULTI_CITY.segments[0]!] }),
    ).toThrow(/at least 2/);
  });
});
