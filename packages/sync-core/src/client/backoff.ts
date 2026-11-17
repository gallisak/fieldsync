/**
 * Delay before retry number `attempt` (0-based): "full jitter", a uniform pick below an exponentially growing,
 * capped bound, so clients that failed together do not come back together.
 */
export function nextDelay(attempt: number, random: () => number, base = 500, cap = 60_000): number {
  return random() * Math.min(cap, base * 2 ** attempt);
}
