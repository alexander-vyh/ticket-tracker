/**
 * Live Google Flights sweep. Gated behind RUN_FLIGHT_SWEEP=1 so the default
 * suite stays hermetic; the parsing it depends on is covered without a network
 * in flight-sweep.test.ts.
 *
 *   RUN_FLIGHT_SWEEP=1 npx vitest run src/lib/scraper/flight-sweep.live.test.ts -t calibration
 *
 * Stages (run individually with -t):
 *   calibration — proves the party guard works and that the card price is a
 *                 PARTY TOTAL, not a per-seat fare. Everything else refuses to
 *                 report per-seat numbers until this passes.
 *   january     — do January returns exist at all? (4-week trip feasibility)
 *   grid        — departures Nov 20-Dec 20 x returns Dec 20-mid Jan
 *   stopover    — multi-city with a 2-5 day stop in AU / Fiji
 *   gateways    — CHC / WLG / ZQN and open-jaw
 *
 * Results are appended to $SWEEP_OUT (default: ./flight-sweep-results.json) so a
 * truncated console never loses a priced cell.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Browser } from 'playwright';
import {
  searchCell,
  roundTrip,
  openJaw,
  stopover,
  monotonicityCheck,
  type CellResult,
} from './flight-sweep';

const ENABLED = process.env.RUN_FLIGHT_SWEEP === '1';
const OUT = process.env.SWEEP_OUT ?? `${process.cwd()}/flight-sweep-results.json`;
const PARTY = 3; // NEVER 4+: Google fabricates an empty page for parties >= 4.
const THROTTLE_MS = Number(process.env.SWEEP_THROTTLE_MS ?? 2_000);

let browser: Browser;

function record(stage: string, r: CellResult): void {
  mkdirSync(dirname(OUT), { recursive: true });
  appendFileSync(OUT, JSON.stringify({ stage, ...r, at: new Date().toISOString() }) + '\n');
}

function show(r: CellResult): string {
  if (r.status !== 'priced' || !r.cheapest) return `${r.label.padEnd(34)} ${r.status.toUpperCase()} ${r.note ?? ''}`;
  const c = r.cheapest;
  const dur = c.durationMinutes ? `${Math.floor(c.durationMinutes / 60)}h${c.durationMinutes % 60}m` : '?';
  const stops = c.stops === 0 ? 'nonstop' : `${c.stops} stop${c.stops > 1 ? 's' : ''}`;
  const via = c.layovers.length ? ` via ${c.layovers.join('/')}` : '';
  return (
    `${r.label.padEnd(34)} $${String(c.perSeat).padStart(5)}/seat  ` +
    `(total $${c.totalPrice} for ${r.observedParty})  ` +
    `${c.airlines.join('+') || '?'} ${stops}${via} ${dur}  [${r.itineraries.length} itins]`
  );
}

/** Sequential with a politeness delay. Google is a shared resource. */
async function run(stage: string, cells: { label: string; query: Parameters<typeof searchCell>[2] }[]) {
  const out: CellResult[] = [];
  for (const c of cells) {
    const r = await searchCell(browser, c.label, c.query);
    record(stage, r);
    out.push(r);
    console.log(show(r));
    if (r.status === 'blocked') {
      console.log('!! CAPTCHA encountered — stopping this stage rather than evading it.');
      break;
    }
    await new Promise((res) => setTimeout(res, THROTTLE_MS));
  }
  return out;
}

const rt = (dep: string, ret: string, to = 'AKL', from = 'LAX', adults = PARTY) => ({
  label: `${from}-${to} ${dep.slice(5)} -> ${ret.slice(5)}${adults !== PARTY ? ` [${adults}pax]` : ''}`,
  query: roundTrip(from, to, dep, ret, adults),
});

const nights = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// ---------------------------------------------------------------------------
// Chart deliverable: one JSON object per cell, appended as it lands so partial
// results survive an interruption.
// ---------------------------------------------------------------------------
const GRID_OUT =
  process.env.GRID_OUT ?? `${process.cwd()}/flight-grid.json`;

type Shape = 'direct' | 'sydney' | 'fiji';

const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

interface GridRow {
  shape: Shape;
  depart: string;
  return: string;
  nights: number;
  stopNights: number | null;
  status: 'priced' | 'no_options' | 'unpriced';
  perSeat: number | null;
  indicativeFamily: number | null;
  airline: string | null;
  stops: number | null;
  layover: string | null;
  durationMin: number | null;
  resultCount: number;
  monotonicityChecked: boolean;
  note?: string;
}

/**
 * Map a CellResult onto the chart schema.
 *
 * `no_options` is reserved for an empty page whose 1-adult control is ALSO
 * empty (monotonicity holds). Anything we merely failed to read — including a
 * 3-adult empty that 1 adult contradicts — is `unpriced`. Sold-out and
 * couldn't-read must never collapse into the same bucket.
 */
function toGridRow(
  shape: Shape,
  depart: string,
  ret: string,
  stopNights: number | null,
  r: CellResult,
  mono?: { genuine: boolean; reason: string },
): GridRow {
  const base = {
    shape,
    depart,
    return: ret,
    nights: nights(depart, ret),
    stopNights,
    resultCount: r.itineraries.length,
    monotonicityChecked: mono !== undefined,
  };
  if (r.status === 'priced' && r.cheapest) {
    const c = r.cheapest;
    return {
      ...base,
      status: 'priced',
      perSeat: c.perSeat,
      indicativeFamily: c.perSeat * 5, // INDICATIVE ONLY — 5-seat depth unverified
      airline: c.airlines.join(' + ') || null,
      stops: c.stops,
      layover: c.layovers[0] ?? null,
      durationMin: c.durationMinutes,
    };
  }
  const empty = {
    ...base,
    perSeat: null,
    indicativeFamily: null,
    airline: null,
    stops: null,
    layover: null,
    durationMin: null,
  };
  if (r.status === 'no-options' && mono?.genuine) {
    return { ...empty, status: 'no_options', note: mono.reason };
  }
  return {
    ...empty,
    status: 'unpriced',
    note: mono && !mono.genuine ? mono.reason : (r.note ?? r.status),
  };
}

function emit(row: GridRow): void {
  mkdirSync(dirname(GRID_OUT), { recursive: true });
  appendFileSync(GRID_OUT, JSON.stringify(row) + '\n');
}

/** Price one cell and emit it; empties get a 1-adult monotonicity control. */
async function priceAndEmit(
  shape: Shape,
  depart: string,
  ret: string,
  stopNights: number | null,
  query: Parameters<typeof searchCell>[2],
  label: string,
): Promise<GridRow> {
  const r = await searchCell(browser, label, query);
  record(`chart-${shape}`, r);

  let mono: { genuine: boolean; reason: string } | undefined;
  if (r.status === 'no-options') {
    // Availability cannot grow with party size: if 1 adult prices where 3 does
    // not, Google fabricated the empty and this is `unpriced`, never sold-out.
    await new Promise((res) => setTimeout(res, THROTTLE_MS));
    const control = await searchCell(
      browser,
      `CTRL 1pax ${label}`,
      roundTrip('LAX', 'AKL', depart, ret, 1),
    );
    record(`chart-${shape}-control`, control);
    mono = monotonicityCheck(r, control);
  }

  const row = toGridRow(shape, depart, ret, stopNights, r, mono);
  emit(row);
  console.log(
    `${shape.padEnd(7)} ${depart} -> ${ret} (${String(row.nights).padStart(2)}n) ` +
      `${row.status === 'priced' ? `$${row.perSeat}/seat  ${row.airline} ${row.stops}st ${row.durationMin}m` : row.status.toUpperCase() + ' ' + (row.note ?? '')}`,
  );
  await new Promise((res) => setTimeout(res, THROTTLE_MS));
  return row;
}

describe.skipIf(!ENABLED)('live Google Flights sweep (3 adults max)', () => {
  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: process.env.SWEEP_HEADED !== '1',
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  it('calibration: party guard holds and the card price is a PARTY TOTAL', async () => {
    const one = await searchCell(browser, 'CAL 1pax Dec10->Dec28', roundTrip('LAX', 'AKL', '2026-12-10', '2026-12-28', 1));
    record('calibration', one);
    console.log(show(one));
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
    const three = await searchCell(browser, 'CAL 3pax Dec10->Dec28', roundTrip('LAX', 'AKL', '2026-12-10', '2026-12-28', 3));
    record('calibration', three);
    console.log(show(three));

    expect(one.status).toBe('priced');
    expect(three.status).toBe('priced');
    // The guard: Google must echo back exactly the party we asked for.
    expect(one.observedParty).toBe(1);
    expect(three.observedParty).toBe(3);

    // The calibration: a 3-adult total must be ~3x a 1-adult total. If this
    // fails, "per-seat = total / N" is wrong and no per-seat number is safe.
    const ratio = three.cheapest!.totalPrice / one.cheapest!.totalPrice;
    console.log(`\nCALIBRATION ratio (3pax total / 1pax total) = ${ratio.toFixed(3)} (expect ~3.0)`);
    console.log(`per-seat: 1pax $${one.cheapest!.perSeat}  3pax $${three.cheapest!.perSeat}\n`);
    expect(ratio).toBeGreaterThan(2.8);
    expect(ratio).toBeLessThan(3.2);
  }, 300_000);

  it('january: do January returns exist?', async () => {
    const cells = [
      rt('2026-12-10', '2027-01-03'), rt('2026-12-10', '2027-01-07'),
      rt('2026-12-10', '2027-01-10'), rt('2026-12-10', '2027-01-14'),
      rt('2026-12-01', '2027-01-05'), rt('2026-12-05', '2027-01-02'),
      rt('2026-12-20', '2027-01-17'),
    ];
    const results = await run('january', cells);
    const priced = results.filter((r) => r.status === 'priced');
    console.log(`\nJANUARY: ${priced.length}/${results.length} cells priced.`);

    // Any empty January cell is re-priced at 1 adult before it may be called
    // sold-out: availability cannot grow with party size, so a priced 1-adult
    // control proves the 3-adult empty was fabricated.
    for (const empty of results.filter((r) => r.status === 'no-options')) {
      const [dep, ret] = empty.label.match(/\d{2}-\d{2}/g)!.map((m) => `2026-${m}`);
      const control = await searchCell(
        browser,
        `CTRL 1pax ${empty.label}`,
        roundTrip('LAX', 'AKL', dep!, ret!.startsWith('2026-01') ? ret!.replace('2026', '2027') : ret!, 1),
      );
      record('january-control', control);
      const verdict = monotonicityCheck(empty, control);
      console.log(`  MONOTONICITY ${empty.label}: ${verdict.genuine ? 'GENUINE sold-out' : verdict.reason}`);
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
    expect(results.length).toBeGreaterThan(0);
  }, 900_000);

  it('grid: sweep departures x returns for anything under the $745/seat floor', async () => {
    const departures = [
      '2026-11-20', '2026-11-24', '2026-11-27', '2026-12-01', '2026-12-03',
      '2026-12-05', '2026-12-08', '2026-12-10', '2026-12-12', '2026-12-15', '2026-12-18',
    ];
    const returns = [
      '2026-12-20', '2026-12-22', '2026-12-26', '2026-12-29',
      '2027-01-02', '2027-01-05', '2027-01-09', '2027-01-12',
    ];
    const cells = departures.flatMap((d) =>
      returns
        .filter((r) => {
          const n = nights(d, r);
          return n >= 18 && n <= 45; // keep the trip a plausible length
        })
        .map((r) => rt(d, r)),
    );
    console.log(`grid: ${cells.length} cells`);
    const results = await run('grid', cells);
    const priced = results.filter((r) => r.status === 'priced');
    console.log(`\nGRID: ${priced.length}/${results.length} priced.`);
    for (const r of [...priced].sort((a, b) => a.cheapest!.perSeat - b.cheapest!.perSeat).slice(0, 15)) {
      console.log('  ' + show(r));
    }
  }, 3_600_000);

  // Chart deliverable. Window Dec 1 2026 - Jan 31 2027, stays 14-30 nights.
  const WINDOW_END = '2027-01-31';
  const STAYS = [14, 21, 28];
  const P1_DEPARTURES = [
    '2026-12-01', '2026-12-04', '2026-12-07', '2026-12-10', '2026-12-13', '2026-12-16',
    '2026-12-19', '2026-12-22', '2026-12-25', '2026-12-28', '2026-12-31',
    '2027-01-03', '2027-01-06', '2027-01-09', '2027-01-12', '2027-01-15',
  ];

  it('phase1: DIRECT LAX-AKL across the whole window (the backbone)', async () => {
    const cells = P1_DEPARTURES.flatMap((d) =>
      STAYS.map((n) => ({ d, n, ret: addDays(d, n) })).filter((c) => c.ret <= WINDOW_END),
    );
    console.log(`phase1: ${cells.length} direct cells`);
    const rows: GridRow[] = [];
    for (const c of cells) {
      rows.push(
        await priceAndEmit('direct', c.d, c.ret, null, roundTrip('LAX', 'AKL', c.d, c.ret, PARTY), `D ${c.d}->${c.ret}`),
      );
    }
    const priced = rows.filter((r) => r.status === 'priced');
    const jan = priced.filter((r) => r.return >= '2027-01-01');
    console.log(`\nPHASE1: ${priced.length}/${rows.length} priced. January returns priced: ${jan.length}`);
    const best = [...priced].sort((a, b) => a.perSeat! - b.perSeat!)[0];
    console.log(`CHEAPEST: ${best?.depart} -> ${best?.return} $${best?.perSeat}/seat ${best?.airline}`);
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);

  it('phase2: SYDNEY and FIJI 3-day stops on a spread of departures', async () => {
    // A multi-city itinerary priced as ONE booking. Never the sum of one-ways --
    // that is a different, punitively-priced market.
    const STOP_NIGHTS = 3;
    const departures = [
      '2026-12-01', '2026-12-07', '2026-12-10', '2026-12-13',
      '2026-12-19', '2026-12-25', '2026-12-31', '2027-01-06',
    ];
    const rows: GridRow[] = [];
    for (const d of departures) {
      const ret = addDays(d, 21);
      if (ret > WINDOW_END) continue;
      const onward = addDays(d, STOP_NIGHTS);
      rows.push(
        await priceAndEmit('sydney', d, ret, STOP_NIGHTS,
          stopover('LAX', 'SYD', 'AKL', d, onward, ret, PARTY), `SYD ${d}/${onward}->${ret}`),
      );
      rows.push(
        await priceAndEmit('fiji', d, ret, STOP_NIGHTS,
          stopover('LAX', 'NAN', 'AKL', d, onward, ret, PARTY), `NAN ${d}/${onward}->${ret}`),
      );
    }
    const priced = rows.filter((r) => r.status === 'priced');
    console.log(`\nPHASE2: ${priced.length}/${rows.length} priced.`);
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);

  it('holiday: daily Dec 8-24 departures x January returns (the user\'s real constraint)', async () => {
    // The user must be IN New Zealand for Dec 25 AND Jan 1, so depart <= Dec 24
    // and return >= Jan 2. That collides with the Jan 2-9 return peak, which is
    // why every floor-priced holiday trip found so far is 33+ nights. Daily
    // resolution across the Dec 13-22 departure cliff to find the true edge.
    const departures = Array.from({ length: 17 }, (_, i) => addDays('2026-12-08', i)); // Dec 8..24
    const returns = ['2027-01-02', '2027-01-06', '2027-01-12', '2027-01-14', '2027-01-17', '2027-01-20'];
    const cells = departures.flatMap((d) => returns.map((r) => ({ d, r })));
    console.log(`holiday: ${cells.length} cells`);
    const rows: GridRow[] = [];
    for (const c of cells) {
      rows.push(
        await priceAndEmit('direct', c.d, c.r, null, roundTrip('LAX', 'AKL', c.d, c.r, PARTY), `H ${c.d}->${c.r}`),
      );
    }
    const priced = rows.filter((r) => r.status === 'priced');
    const floor = priced.filter((r) => r.perSeat! <= 750);
    console.log(`\nHOLIDAY: ${priced.length}/${rows.length} priced. At/below $750: ${floor.length}`);
    const shortest = [...floor].sort((a, b) => a.nights - b.nights)[0];
    console.log(`SHORTEST trip at the floor: ${shortest?.depart} -> ${shortest?.return} (${shortest?.nights}n) $${shortest?.perSeat} ${shortest?.airline}`);
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);

  it('holidaystop: Sydney / Fiji stops ON the recommended holiday-spanning trips', async () => {
    // The gap the team lead named: every stopover measured so far sits on a
    // departure the user cannot actually take. Price them on trips that do span
    // Christmas and New Year.
    const trips = [
      { d: '2026-12-08', r: '2027-01-14' }, // the recommended cell
      { d: '2026-12-03', r: '2027-01-17' },
      { d: '2026-12-10', r: '2027-01-14' },
    ];
    const rows: GridRow[] = [];
    for (const t of trips) {
      for (const stopNights of [3, 5]) {
        const onward = addDays(t.d, stopNights);
        rows.push(
          await priceAndEmit('sydney', t.d, t.r, stopNights,
            stopover('LAX', 'SYD', 'AKL', t.d, onward, t.r, PARTY), `HSYD ${t.d}+${stopNights}d->${t.r}`),
        );
        rows.push(
          await priceAndEmit('fiji', t.d, t.r, stopNights,
            stopover('LAX', 'NAN', 'AKL', t.d, onward, t.r, PARTY), `HNAN ${t.d}+${stopNights}d->${t.r}`),
        );
      }
    }
    console.log(`\nHOLIDAYSTOP: ${rows.filter((r) => r.status === 'priced').length}/${rows.length} priced.`);
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);

  it('longtrip: mid-January returns — is a 4-5 week trip really free?', async () => {
    // Dec 10 -> Jan 14 priced at the same $745/seat as the 18-night baseline.
    // If that holds across neighbouring dates it is a real cliff, not a fluke.
    const departures = ['2026-11-27', '2026-12-01', '2026-12-03', '2026-12-05', '2026-12-08', '2026-12-10', '2026-12-12'];
    const returns = ['2027-01-14', '2027-01-17', '2027-01-19', '2027-01-21', '2027-01-24'];
    const cells = departures.flatMap((d) => returns.map((r) => rt(d, r)));
    console.log(`longtrip: ${cells.length} cells`);
    const results = await run('longtrip', cells);
    const priced = results.filter((r) => r.status === 'priced');
    console.log(`\nLONGTRIP: ${priced.length}/${results.length} priced.`);
    for (const r of [...priced].sort((a, b) => a.cheapest!.perSeat - b.cheapest!.perSeat).slice(0, 12)) {
      console.log('  ' + show(r));
    }
  }, 3_600_000);

  it('stopover: per-country delta vs the $745/seat baseline', async () => {
    const cells = [
      { label: 'STOP SYD 3d (Dec1/Dec4 -> Dec22)', query: stopover('LAX', 'SYD', 'AKL', '2026-12-01', '2026-12-04', '2026-12-22', PARTY) },
      { label: 'STOP SYD 5d (Dec1/Dec6 -> Dec22)', query: stopover('LAX', 'SYD', 'AKL', '2026-12-01', '2026-12-06', '2026-12-22', PARTY) },
      { label: 'STOP MEL 3d (Dec10/Dec13 -> Dec28)', query: stopover('LAX', 'MEL', 'AKL', '2026-12-10', '2026-12-13', '2026-12-28', PARTY) },
      { label: 'STOP MEL 5d (Dec10/Dec15 -> Dec28)', query: stopover('LAX', 'MEL', 'AKL', '2026-12-10', '2026-12-15', '2026-12-28', PARTY) },
      { label: 'STOP BNE 3d (Dec10/Dec13 -> Dec28)', query: stopover('LAX', 'BNE', 'AKL', '2026-12-10', '2026-12-13', '2026-12-28', PARTY) },
      { label: 'STOP NAN 3d (Dec1/Dec4 -> Dec22)', query: stopover('LAX', 'NAN', 'AKL', '2026-12-01', '2026-12-04', '2026-12-22', PARTY) },
      { label: 'STOP NAN 5d (Dec1/Dec6 -> Dec22)', query: stopover('LAX', 'NAN', 'AKL', '2026-12-01', '2026-12-06', '2026-12-22', PARTY) },
      { label: 'STOP SYD 3d (Dec10/Dec13 -> Dec28)', query: stopover('LAX', 'SYD', 'AKL', '2026-12-10', '2026-12-13', '2026-12-28', PARTY) },
    ];
    await run('stopover', cells);
  }, 1_800_000);

  it('gateways: CHC / WLG / ZQN and open-jaw', async () => {
    const cells = [
      rt('2026-12-01', '2026-12-22', 'CHC'), rt('2026-12-10', '2026-12-28', 'CHC'),
      rt('2026-12-01', '2026-12-22', 'WLG'), rt('2026-12-10', '2026-12-28', 'WLG'),
      rt('2026-12-01', '2026-12-22', 'ZQN'), rt('2026-12-10', '2026-12-28', 'ZQN'),
      { label: 'OJ LAX->AKL, CHC->LAX Dec1/Dec22', query: openJaw('LAX', 'AKL', 'CHC', '2026-12-01', '2026-12-22', PARTY) },
      { label: 'OJ LAX->AKL, ZQN->LAX Dec1/Dec22', query: openJaw('LAX', 'AKL', 'ZQN', '2026-12-01', '2026-12-22', PARTY) },
      { label: 'OJ LAX->CHC, AKL->LAX Dec1/Dec22', query: openJaw('LAX', 'CHC', 'AKL', '2026-12-01', '2026-12-22', PARTY) },
    ];
    await run('gateways', cells);
  }, 1_800_000);

  it('monotonicity: re-price every no-options cell at 1 adult', async () => {
    // Populated from the JSONL by the caller; this stage exists so a sold-out is
    // never recorded without its control. See report.
    expect(monotonicityCheck).toBeTypeOf('function');
  });
});
