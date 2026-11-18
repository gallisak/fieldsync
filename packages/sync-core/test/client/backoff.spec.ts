import { nextDelay } from '../../src/client/backoff';

describe('nextDelay (full jitter)', () => {
  const highest = () => 1 - Number.EPSILON;

  it('stays at or below the base on the first retry', () => {
    expect(nextDelay(0, highest)).toBeLessThanOrEqual(500);
    expect(nextDelay(0, () => 0)).toBe(0);
  });

  it('has an upper bound that never shrinks and never passes the cap', () => {
    const bounds = Array.from({ length: 30 }, (_, attempt) => nextDelay(attempt, highest));
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]).toBeGreaterThanOrEqual(bounds[i - 1]);
    expect(Math.max(...bounds)).toBeLessThanOrEqual(60_000);
    expect(bounds[bounds.length - 1]).toBeGreaterThan(59_000);
  });

  it('picks uniformly below the bound', () => {
    expect(nextDelay(3, () => 0.5)).toBe(2_000);
    expect(nextDelay(20, () => 0.25)).toBe(15_000);
  });
});
