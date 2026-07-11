/**
 * Tier-1 parser for Google Flights server-side-rendered results.
 *
 * Ported from fast-flights' parser.py (AWeirdDev/flights, MIT; payload map
 * discovered by @kftang). The SSR page embeds an AF_initDataCallback blob in
 * `<script class="ds:1">`; flight rows live at payload[3][0]. Index map per
 * leg (single_flight): [3]=from code, [4]=from name, [5]=to name, [6]=to code,
 * [8]=departure time, [10]=arrival time, [11]=duration min, [17]=plane type,
 * [20]=departure date, [21]=arrival date.
 */
import type { DataplaneFlight, DataplaneLeg, SsrParseResult } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any -- the payload is a
   reverse-engineered positional array; typing it nominally would be fiction */

export function parseSsrHtml(html: string): SsrParseResult {
  const script = extractDs1(html);
  if (!script) return { status: 'error', reason: 'no ds:1 script in page' };

  const dataStart = script.indexOf('data:');
  if (dataStart === -1) return { status: 'error', reason: 'no data: blob in ds:1' };
  // parser.py: js.split("data:", 1)[1].rsplit(",", 1)[0] — everything after
  // `data:` minus the trailing `, sideChannel: {}})` tail.
  const afterData = script.slice(dataStart + 'data:'.length);
  const dataJson = afterData.slice(0, afterData.lastIndexOf(','));

  if (dataJson.trimEnd().endsWith('errorHasStatus: true')) {
    return { status: 'error', reason: 'Google returned errorHasStatus' };
  }

  let payload: any;
  try {
    payload = JSON.parse(dataJson);
  } catch {
    return { status: 'error', reason: 'ds:1 data blob is not valid JSON' };
  }

  const slot3 = payload?.[3];
  if (slot3 == null) {
    // Google understood the query but deferred results to client-side JS.
    // Measured: every children>0 query does this. NOT "no flights".
    return { status: 'deferred' };
  }

  const rows = slot3[0];
  if (rows == null) {
    // upstream fast-flights treats payload[3][0]=null as an empty result set
    return { status: 'ok', flights: [] };
  }

  const flights: DataplaneFlight[] = [];
  for (const row of rows) {
    const flight = row[0];
    const price = row?.[1]?.[0]?.[1];
    if (typeof price !== 'number' || !Array.isArray(flight?.[2])) continue;

    const legs: DataplaneLeg[] = flight[2].map(
      (leg: any): DataplaneLeg => ({
        fromAirport: leg[3] ?? '',
        fromAirportName: leg[4] ?? null,
        toAirport: leg[6] ?? '',
        toAirportName: leg[5] ?? null,
        departureDate: leg[20] ?? null,
        departureTime: leg[8] ?? null,
        arrivalDate: leg[21] ?? null,
        arrivalTime: leg[10] ?? null,
        duration: leg[11] ?? null,
        planeType: leg[17] ?? null,
      }),
    );

    flights.push({
      price,
      airlines: Array.isArray(flight[1]) ? flight[1] : [],
      legs,
    });
  }

  return { status: 'ok', flights };
}

function extractDs1(html: string): string | null {
  // fixtures/pages carry the element as `<script class="ds:1" ...>...</script>`
  const m = /<script[^>]*class="ds:1"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (m) return m[1]!;
  // tolerate being handed the bare script content
  return html.includes('AF_initDataCallback') ? html : null;
}
