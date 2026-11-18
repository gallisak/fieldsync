import type { SimConfig } from '../../src/testing';

const PHASE_4: SimConfig['flags'] = { crash: true, tabs: true, access: false, gc: false };
const WITH_ACCESS: SimConfig['flags'] = { crash: true, tabs: true, access: true, gc: false };
const WITH_GC: SimConfig['flags'] = { crash: true, tabs: true, access: true, gc: true };

export const REGRESSION_SEEDS: { seed: number; steps: number; flags: SimConfig['flags']; found: string }[] = [
  {
    seed: 30,
    steps: 1,
    flags: PHASE_4,
    found: 'F4: a server that does not deduplicate applies a retried mutation twice',
  },
  { seed: 47, steps: 3, flags: PHASE_4, found: 'F5: a rejection that does not advance the client blocks its queue' },
  { seed: 91, steps: 2, flags: PHASE_4, found: 'F15: a follower tab that ignores state-changed keeps a stale base' },
  {
    seed: 91,
    steps: 45,
    flags: PHASE_4,
    found: "F15: a leader that ignores queue-changed never pushes another tab's mutation",
  },
  {
    seed: 69,
    steps: 6,
    flags: WITH_ACCESS,
    found: 'F12: without a snapshot on an access change, a client keeps revoked rows and misses granted ones',
  },
  {
    seed: 10,
    steps: 11,
    flags: WITH_GC,
    found: 'F13: GC without a retained floor lets a client whose cursor it passed miss the collected changes',
  },
];
