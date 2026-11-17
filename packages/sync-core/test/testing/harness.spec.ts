import { DEFAULT_FAULTS, runSimulation, type SimConfig } from '../../src/testing';

const ALL_FLAGS = { crash: true, tabs: true, access: true, gc: true };
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
    const cfg: SimConfig = { seed: 1, steps: 50, clients: 3, faults: DEFAULT_FAULTS, flags: ALL_FLAGS };
    const first = await runSimulation(cfg);
    expect(await runSimulation(cfg)).toEqual(first);

    expect(first.trace).toHaveLength(50);
    expect(first.applied).toBeGreaterThan(0);
    expect(first.endTime).toBeGreaterThan(600_000);
    expect((await runSimulation({ ...cfg, seed: 2 })).trace).not.toEqual(first.trace);
  });

  it('draws every action when all flags are on, and no flagged one when they are off', async () => {
    // Seed 1 gives one device to the admin, without whom there are no moves.
    const base = { seed: 1, steps: 400, clients: 3, faults: DEFAULT_FAULTS };
    const on = await runSimulation({ ...base, flags: ALL_FLAGS });
    expect([...kinds(on.trace)].sort()).toEqual([
      'advance',
      'close-tab',
      'crash',
      'gc',
      'grant',
      'long-offline',
      'move',
      'mutate',
      'open-tab',
      'partition',
      'revoke',
    ]);
    const off = await runSimulation({ ...base, flags: NO_FLAGS });
    expect([...kinds(off.trace)].sort()).toEqual(['advance', 'mutate', 'partition']);
  });
});
