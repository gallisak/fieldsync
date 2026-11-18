import { DEFAULT_FAULTS, SimulationFailure, runSimulation, type SimConfig } from '../../src/testing';
import { REGRESSION_SEEDS } from './regression-seeds';

const FLAGS: SimConfig['flags'] = { crash: true, tabs: true, access: true, gc: true };

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

const ONLY = envInt('SIM_SEED');
const STEPS = envInt('SIM_STEPS') ?? 400;
const SEEDS = ONLY !== undefined ? [ONLY] : Array.from({ length: envInt('SIM_SEEDS') ?? 500 }, (_, i) => i + 1);

const config = (seed: number, steps: number, flags: SimConfig['flags']): SimConfig => ({
  seed,
  steps,
  clients: 3,
  faults: DEFAULT_FAULTS,
  flags,
});

async function failure(seed: number, steps: number, flags = FLAGS): Promise<SimulationFailure | undefined> {
  try {
    await runSimulation(config(seed, steps, flags));
    return undefined;
  } catch (err) {
    if (err instanceof SimulationFailure) return err;
    throw err;
  }
}

async function expectPasses(seed: number, steps: number, flags = FLAGS): Promise<void> {
  if (!(await failure(seed, steps, flags))) return;
  let lo = 0;
  let hi = steps;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await failure(seed, mid, flags)) hi = mid;
    else lo = mid + 1;
  }
  const smallest = await failure(seed, hi, flags);
  const own = flags === FLAGS ? '' : ` (with flags ${JSON.stringify(flags)})`;
  throw new Error(
    `seed ${seed} fails; the smallest failing run has ${hi} steps: SIM_SEED=${seed} SIM_STEPS=${hi} npm run sim${own}\n\n` +
      String(smallest?.message),
  );
}

describe('simulation against ModelServer', () => {
  if (ONLY === undefined && REGRESSION_SEEDS.length > 0) {
    it.each(REGRESSION_SEEDS)(
      'regression seed $seed ($steps steps): $found',
      ({ seed, steps, flags }) => expectPasses(seed, steps, flags),
      60_000,
    );
  }

  if (SEEDS.length > 0) it.each(SEEDS)('seed %i', (seed) => expectPasses(seed, STEPS), 60_000);
});
