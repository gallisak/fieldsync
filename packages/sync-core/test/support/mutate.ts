import { MutationRejected, getMutator, type MutatorTx, type RejectionCode } from '../../src';

export const CTX = { now: '2026-01-01T10:00:00.000Z' };

export function run(tx: MutatorTx, name: string, args: unknown, ctx = CTX): void {
  const def = getMutator(name);
  if (!def) throw new Error(`no mutator ${name}`);
  def.apply(tx, args, ctx);
}

/** Runs the mutation and returns the rejection; fails the test if it was not rejected. */
export function rejectionOf(tx: MutatorTx, name: string, args: unknown): MutationRejected {
  try {
    run(tx, name, args);
  } catch (err) {
    if (err instanceof MutationRejected) return err;
    throw err;
  }
  throw new Error(`${name} was expected to be rejected`);
}

export function expectRejected(tx: MutatorTx, name: string, args: unknown, code: RejectionCode): MutationRejected {
  const err = rejectionOf(tx, name, args);
  expect(err.code).toBe(code);
  return err;
}
