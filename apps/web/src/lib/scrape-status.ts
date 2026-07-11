export type ScrapeStatus = 'in_progress' | 'success' | 'partial' | 'failed' | 'no_options';

export interface SiblingScrape {
  status: ScrapeStatus | string | null;
  error: string | null;
  startedAt: string | null;
  /**
   * FetchRun.availability: 'available' | 'no_options' | 'throttled' | null.
   * A run that succeeded but determined the route has no bookable option
   * (availability='no_options') is surfaced as its own status rather than a
   * plain green success — otherwise a genuinely sold-out route looks priced.
   * (ticket-tracker-98s / uwj)
   */
  availability?: string | null;
}

export interface AggregatedScrape {
  status: ScrapeStatus | null;
  error: string | null;
  startedAt: string | null;
  failingSiblings: number;
}

// no_options ranks BELOW success: when siblings disagree (a local pass finds no
// availability but a VPN-country pass prices a fare) the "available" success
// wins, so the sold-out marker shows only when nothing bookable exists anywhere.
const ORDER: ScrapeStatus[] = ['in_progress', 'failed', 'partial', 'success', 'no_options'];

function normalize(sibling: SiblingScrape): ScrapeStatus | null {
  const { status, availability } = sibling;
  const base =
    status === 'in_progress' || status === 'success' || status === 'partial' || status === 'failed'
      ? status
      : null;
  // A clean success that determined the route has no bookable option is a
  // distinct, first-class state — not a plain success. (ticket-tracker-98s)
  if (base === 'success' && availability === 'no_options') return 'no_options';
  return base;
}

/**
 * Pick the "most attention worthy" status across siblings.
 *
 * Order: in_progress > failed > partial > success > null.
 * Rationale: an active scrape always wins so the dot pulses while the
 * refresh is in flight; otherwise we surface the worst terminal state so a
 * single failing sibling can't hide behind successful ones.
 *
 * `error` follows the picked status (first matching sibling). `startedAt`
 * is the most recent across siblings regardless of status, so the tooltip
 * timestamp always reflects when something last happened.
 */
export function aggregateScrapeStatus(siblings: SiblingScrape[]): AggregatedScrape {
  if (siblings.length === 0) {
    return { status: null, error: null, startedAt: null, failingSiblings: 0 };
  }

  let mostRecent: string | null = null;
  let failingSiblings = 0;
  for (const s of siblings) {
    if (s.startedAt && (mostRecent === null || s.startedAt > mostRecent)) {
      mostRecent = s.startedAt;
    }
    if (normalize(s) === 'failed') failingSiblings += 1;
  }

  for (const want of ORDER) {
    const match = siblings.find((s) => normalize(s) === want);
    if (match) {
      return {
        status: want,
        error: match.error,
        startedAt: mostRecent,
        failingSiblings,
      };
    }
  }

  return { status: null, error: null, startedAt: mostRecent, failingSiblings: 0 };
}
