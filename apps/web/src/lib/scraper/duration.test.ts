import { describe, it, expect } from 'vitest';
import { parseDurationToMinutes } from './duration';

describe('parseDurationToMinutes', () => {
  it('parses hours and minutes', () => {
    expect(parseDurationToMinutes('11h 20m')).toBe(11 * 60 + 20);
  });

  it('parses hours only', () => {
    expect(parseDurationToMinutes('2h')).toBe(120);
  });

  it('parses minutes only', () => {
    expect(parseDurationToMinutes('45m')).toBe(45);
  });

  it('returns null for empty string', () => {
    expect(parseDurationToMinutes('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseDurationToMinutes(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseDurationToMinutes(undefined)).toBeNull();
  });

  it('returns null when no h or m markers are present', () => {
    expect(parseDurationToMinutes('abc')).toBeNull();
    expect(parseDurationToMinutes('11')).toBeNull();
  });

  it('also parses ISO 8601 PT12H30M as a side effect of the loose regex', () => {
    // This is incidental: the regex matches the H and M markers.
    expect(parseDurationToMinutes('PT12H30M')).toBe(12 * 60 + 30);
  });

  it('handles uppercase H and M', () => {
    expect(parseDurationToMinutes('5H 10M')).toBe(310);
  });
});
