import { DEFAULT_FAULTS, SimulationFailure, runSimulation, type SimConfig } from '../../src/testing';
import { REGRESSION_SEEDS } from './regression-seeds';

/** Phase 4: crashes and tabs. Access changes (F12) and gc (F13) are switched on by P5.4 and P6.2. */
const FLAGS: SimConfig['flags'] = { crash: true, tabs: true, access: false, gc: false };

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

/**
 * `SIM_SEED` runs one seed; `SIM_SEEDS` runs the regression seeds and then seeds 1 … n (default 500, 0 for the
 * regression seeds only); `SIM_STEPS` sets the steps (default 400).
 */
const ONLY = envInt('SIM_SEED');
const STEPS = envInt('SIM_STEPS') ?? 400;
const SEEDS = ONLY !== undefined ? [ONLY] : Array.from({ length: envInt('SIM_SEEDS') ?? 500 }, (_, i) => i + 1);

const config = (seed: number, steps: number): SimConfig => ({
  seed,
  steps,
  clients: 3,
  faults: DEFAULT_FAULTS,
  flags: FLAGS,
});

async function failure(seed: number, steps: number): Promise<SimulationFailure | undefined> {
  try {
    await runSimulation(config(seed, steps));
    return undefined;
  } catch (err) {
    if (err instanceof SimulationFailure) return err;
    throw err;
  }
}

/** On a failure, binary-searches the step count down and reports the smallest failing run and how to repeat it. */
async function expectPasses(seed: number, steps: number): Promise<void> {
  if (!(await failure(seed, steps))) return;
  let lo = 0;
  let hi = steps;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await failure(seed, mid)) hi = mid;
    else lo = mid + 1;
  }
  const smallest = await failure(seed, hi);
  throw new Error(
    `seed ${seed} fails; the smallest failing run has ${hi} steps: SIM_SEED=${seed} SIM_STEPS=${hi} npm run sim\n\n` +
      String(smallest?.message),
  );
}

describe('simulation against ModelServer', () => {
  if (ONLY === undefined && REGRESSION_SEEDS.length > 0) {
    it.each(REGRESSION_SEEDS)(
      'regression seed $seed ($steps steps): $found',
      ({ seed, steps }) => expectPasses(seed, steps),
      60_000,
    );
  }

  if (SEEDS.length > 0) it.each(SEEDS)('seed %i', (seed) => expectPasses(seed, STEPS), 60_000);
});
