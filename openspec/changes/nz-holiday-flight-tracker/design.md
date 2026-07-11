# Design: nz-holiday-flight-tracker

**Status:** approved (user delegated all decisions 2026-07-10: "drive all decisions")
**Molecule:** ticket-tracker-mol-dyz

## Problem

Track cheap LAX→New Zealand fares for a 5-passenger family (adults 76/38/38,
children 5/3) for a ~3-week 2026-27 holiday trip, with price history and alerts.
Google Flights' native alerts can't do multi-route dashboards, history charts, or
5-pax family tracking; the free-API ecosystem died mid-2026 (Amadeus decommissioned,
Tequila invite-only, Skyscanner partner-only).

## Decision

Fork **affromero/flight-finder** (MIT, TS/Next.js/Prisma/Playwright+LLM) as the
product layer, and add a **two-tier Google Flights data plane**:

1. **Tier 1 — protobuf/SSR fetch (fast, cheap):** build the `tfs` URL (ported from
   fast-flights' proven encoder), plain HTTPS GET, parse the SSR payload. ~1.5 s,
   no browser, no LLM. Works for most 1-4-pax queries.
2. **Tier 2 — Playwright + LLM (existing flight-finder pipeline):** same `tfs` URL
   driven in the headless browser (client-side fetch executes there), local-MLX LLM
   extracts. Required whenever Google defers results out of the SSR payload —
   *measured* to include exactly our 5-pax international case.

One `tfs` builder feeds both tiers; the scrape orchestrator tries Tier 1 and falls
back to Tier 2 on empty-SSR.

## Riskiest assumption (tested 2026-07-10, walking skeleton)

"A no-browser protobuf query can price a 5-pax mixed-age LAX→AKL holiday round trip."
**Result: FALSE, for two independent reasons — both now design inputs:**

- Google defers 5-pax international results out of SSR (`payload[3] = null` while the
  page's own passenger widget shows the query understood). Tier 2 fallback is
  therefore mandatory, not optional. (Encoding verified correct: packed varints
  `[1,1,1,2,2]` = 3 adults + 2 children; children work fine SSR-side on LAX→HNL.)
- Ground truth via real browser: **Dec 18 → Jan 8 RT for 3ad+2ch has NO bookable
  options at all** ("No results returned"), while the Dec 18 one-way prices at
  $9,398 total. Peak-season return inventory is the constraint.

## Requirements (drawn from the skeleton evidence)

R1. Passengers end-to-end: `adults/children/infantsInSeat/infantsOnLap` on the Query
    model, NL parse (already extracts count), create API, tfs builder, scrape, UI.
    flight-finder currently has NONE of this (hardcodes 1 adult).
R2. Two-tier data plane with per-snapshot provenance (`source: ssr | browser-llm`).
R3. "No availability" is a first-class tracked state (NOT an error, NOT silently
    empty): store it, chart it, alert when it flips to available.
R4. Date-grid exploration: a tracker covers a date window (e.g. depart Dec 12-22,
    return Jan 2-12, 19-23 day span), not a single date pair.
R5. Leg-split pricing: track outbound and return one-ways separately alongside RT,
    since one-ways may exist when RTs don't (measured: they do).
R6. Keep flight-finder's notification channels (ntfy/email/Telegram/webhook) wired
    to R3/R4 events.

## Non-goals

- Award/miles search (seats.aero later), multi-city, VPN price comparison,
  community hub features, desktop app packaging.
- Fixing fast-flights upstream (we port its encoder, not depend on the package).

## Test case (canonical, user-specified)

LAX→AKL, 3 adults + 2 children, depart 2026-12-18 ±flex, return 2027-01-08 ±flex
(~21 days). Success = tracker shows RT no-availability state, one-way prices for
both legs, and a date-grid of nearby combos with total family price.

## Architecture notes

- Fork lands at repo root (apps/, packages/, prisma etc.), MIT LICENSE + NOTICE
  preserved, upstream remote documented for cherry-picking fixes.
- Local LLM: existing MLX qwen3.6-35b-dwq via OPENAI_BASE_URL (proven, $0).
- Data plane code in `apps/web/src/lib/dataplane/` (tfs-builder.ts, ssr-fetch.ts,
  ssr-parse.ts, orchestrator.ts) with unit tests against captured fixtures.
