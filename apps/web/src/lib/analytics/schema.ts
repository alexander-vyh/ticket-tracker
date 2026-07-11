/**
 * Analytics database schema (SQLite).
 * TypeScript interfaces only — actual table creation in db.ts via raw SQL.
 */

export interface PageEvent {
  id: number;
  timestamp: number;
  type: string;
  path: string;
  referrer: string | null;
  visitor_id: string;
  session_id: string;
  user_agent: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  country: string | null;
  is_bot: number;
  bot_score: number;
  duration_ms: number | null;
  scroll_depth: number | null;
  meta: string | null;
}

export interface DailyStat {
  id: number;
  date: string;
  path: string;
  views: number;
  unique_visitors: number;
}

export interface ReferrerStat {
  id: number;
  date: string;
  referrer: string;
  count: number;
}

export interface DailySalt {
  date: string;
  salt: string;
}
