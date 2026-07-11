// Throwaway capture script — run once via `npx tsx capture-fixtures.ts`, then deleted.
// Not part of the shipped dataplane; do not import from anywhere.
import { writeFileSync } from 'node:fs';
import { buildTfsUrl, type TfsQuery } from '../tfs-builder';

const BASE: Omit<TfsQuery, 'passengers'> = {
  trip: 'round-trip',
  seat: 'economy',
  segments: [
    { date: '2026-12-18', fromAirport: 'LAX', toAirport: 'AKL' },
    { date: '2027-01-08', fromAirport: 'AKL', toAirport: 'LAX' },
  ],
};

const SOCS_COOKIE = 'CAISHAgBEhJnd3NfMjAyNDA4MDYtMF9SQzIaAmVuIAEaBgiAo_C1Bg';

const HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  cookie: `SOCS=${SOCS_COOKIE}`,
};

async function capture(name: string, query: TfsQuery) {
  const url = buildTfsUrl(query);
  console.log(`\n=== ${name} ===\n${url}`);
  const res = await fetch(url, { headers: HEADERS });
  console.log(`status: ${res.status}, final url: ${res.url}`);
  const html = await res.text();
  console.log(`bytes: ${html.length}`);
  const outPath = new URL(`../__fixtures__/${name}.raw.html`, import.meta.url);
  writeFileSync(outPath, html);
  console.log(`wrote ${outPath.pathname}`);

  const match = html.match(/data:(\[.*?\]), sideChannel/);
  console.log(
    `ds:1 payload found: ${Boolean(match)}${match ? `, length ${match[1].length}` : ''}`,
  );
}

async function main() {
  await capture('adults-only-with-results', {
    ...BASE,
    passengers: { adults: 3 },
  });
  // be polite between requests
  await new Promise((r) => setTimeout(r, 1500));
  await capture('deferred-5pax', {
    ...BASE,
    passengers: { adults: 3, children: 2 },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
