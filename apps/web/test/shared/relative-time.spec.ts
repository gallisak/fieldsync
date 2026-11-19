import { formatRelative } from '@/shared/lib/relative-time';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe('formatRelative', () => {
  it.each([
    [ago(10), 'just now'],
    [ago(5 * 60), '5 minutes ago'],
    [ago(3 * 60 * 60), '3 hours ago'],
    [ago(24 * 60 * 60), 'yesterday'],
    [ago(40 * 24 * 60 * 60), 'May 6, 2026'],
    [new Date(NOW + 2 * 60 * 60 * 1000).toISOString(), 'in 2 hours'],
    ['not a date', ''],
  ])('%s → "%s"', (iso, text) => {
    expect(formatRelative(iso, NOW)).toBe(text);
  });
});
