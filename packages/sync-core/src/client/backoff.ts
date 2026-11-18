export function nextDelay(attempt: number, random: () => number, base = 500, cap = 60_000): number {
  return random() * Math.min(cap, base * 2 ** attempt);
}
