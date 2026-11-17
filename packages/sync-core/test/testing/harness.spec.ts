import { DEFAULT_FAULTS, runSimulation, type SimConfig } from '../../src/testing';

/** What phase 4 runs with: access changes (F12) and gc (F13) are switched on by P5.4 and P6.2. */
const PHASE_4 = { crash: true, tabs: true, access: false, gc: false };
const NO_FLAGS = { crash: false, tabs: false, access: false, gc: false };

/** The action kinds of a trace; a move is a mutate by the admin, listed by its mutator name. */
const kinds = (trace: string[]) =>
  new Set(
    trace.map((line) => {
      const action = JSON.parse(line.slice(line.indexOf('{'))) as { kind: string; name?: string };
      return action.name === 'ticket.move' ? 'move' : action.kind;
    }),
  );

describe('runSimulation', () => {
  it('returns the same report twice for the same seed', async () => {
    const cfg: SimConfig = { seed: 1, steps: 50, clients: 3, faults: DEFAULT_FAULTS, flags: PHASE_4 };
    const first = await runSimulation(cfg);
    expect(await runSimulation(cfg)).toEqual(first);

    expect(first.trace).toHaveLength(50);
    expect(first.applied).toBeGreaterThan(0);
    expect(first.endTime).toBeGreaterThan(600_000);
    expect((await runSimulation({ ...cfg, seed: 2 })).trace).not.toEqual(first.trace);
  });

  it('draws only the actions whose flag is on', async () => {
    const base = { seed: 1, steps: 400, clients: 3, faults: DEFAULT_FAULTS };
    const on = await runSimulation({ ...base, flags: PHASE_4 });
    expect([...kinds(on.trace)].sort()).toEqual(['advance', 'close-tab', 'crash', 'mutate', 'open-tab', 'partition']);
    const off = await runSimulation({ ...base, flags: NO_FLAGS });
    expect([...kinds(off.trace)].sort()).toEqual(['advance', 'mutate', 'partition']);
  });
});
