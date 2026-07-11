/**
 * Parse a human duration string like "11h 20m" or "2h" into total minutes.
 * Returns null when the string contains neither hours nor minutes (e.g. empty,
 * null, or unrecognized formats like "PT12H30M"). Callers treat null as
 * "unparseable, do not filter on it".
 */
export function parseDurationToMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const h = s.match(/(\d+)\s*h/i);
  const m = s.match(/(\d+)\s*m/i);
  if (!h && !m) return null;
  const hours = h ? parseInt(h[1]!, 10) : 0;
  const mins = m ? parseInt(m[1]!, 10) : 0;
  return hours * 60 + mins;
}
