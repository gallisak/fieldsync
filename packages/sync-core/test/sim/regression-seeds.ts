/**
 * Every seed that ever failed during development, with the smallest failing step count and what it found. They
 * run before the seed sweep, with the same configuration. The README "Simulation" section is written from this
 * list. The first entries come from the P4.4 self-check: each fails when that one fix is reverted.
 */
export const REGRESSION_SEEDS: { seed: number; steps: number; found: string }[] = [
  { seed: 30, steps: 1, found: 'F4: a server that does not deduplicate applies a retried mutation twice' },
  { seed: 56, steps: 3, found: 'F5: a rejection that does not advance the client blocks its queue' },
  { seed: 91, steps: 2, found: 'F15: a follower tab that ignores state-changed keeps a stale base' },
  { seed: 86, steps: 27, found: "F15: a leader that ignores queue-changed never pushes another tab's mutation" },
];
