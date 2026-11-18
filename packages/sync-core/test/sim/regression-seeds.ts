import type { SimConfig } from '../../src/testing';

/** The flags of phase 4, when the first seeds were found. */
const PHASE_4: SimConfig['flags'] = { crash: true, tabs: true, access: false, gc: false };
const WITH_ACCESS: SimConfig['flags'] = { crash: true, tabs: true, access: true, gc: false };

/**
 * Every seed that ever failed during development, with the flags and the smallest failing step count it was
 * found with, and what it found. They run before the seed sweep. The README "Simulation" section is written
 * from this list. Each entry fails when that one fix is reverted.
 */
export const REGRESSION_SEEDS: { seed: number; steps: number; flags: SimConfig['flags']; found: string }[] = [
  {
    seed: 30,
    steps: 1,
    flags: PHASE_4,
    found: 'F4: a server that does not deduplicate applies a retried mutation twice',
  },
  { seed: 56, steps: 3, flags: PHASE_4, found: 'F5: a rejection that does not advance the client blocks its queue' },
  { seed: 91, steps: 2, flags: PHASE_4, found: 'F15: a follower tab that ignores state-changed keeps a stale base' },
  {
    seed: 86,
    steps: 27,
    flags: PHASE_4,
    found: "F15: a leader that ignores queue-changed never pushes another tab's mutation",
  },
  {
    seed: 31,
    steps: 12,
    flags: WITH_ACCESS,
    found: 'F12: without a snapshot on an access change, a client keeps revoked rows and misses granted ones',
  },
];
