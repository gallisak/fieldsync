import type { z } from 'zod';
import type { RejectionCode } from '../protocol/errors';
import type { EntityName, Row } from '../protocol/types';

export class MutationRejected extends Error {
  constructor(
    readonly code: RejectionCode,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = 'MutationRejected';
  }
}

export interface Key {
  entity: EntityName;
  id: string;
}

export interface ScanSpec {
  entity: 'part';
  by: { ticketId: string };
}

export interface MutatorCtx {
  now: string;
}

export interface MutatorTx {
  get(entity: EntityName, id: string): Row | undefined;
  exists(entity: EntityName, id: string): boolean;
  scan(entity: 'part', by: { ticketId: string }): Row[];
  put(entity: EntityName, id: string, row: Row): void;
  del(entity: EntityName, id: string): void;
  /** Whether a user may see a site. Only the server knows; a client applies optimistically without it. */
  canSee?(userId: string, siteId: string): boolean;
}

export interface MutatorDef {
  parse(args: unknown): unknown;
  reads(args: unknown): Key[];
  scans(args: unknown): ScanSpec[];
  apply(tx: MutatorTx, args: unknown, ctx: MutatorCtx): void;
}

export function defineMutator<S extends z.ZodType>(spec: {
  args: S;
  reads(a: z.infer<S>): Key[];
  scans?(a: z.infer<S>): ScanSpec[];
  apply(tx: MutatorTx, a: z.infer<S>, ctx: MutatorCtx): void;
}): MutatorDef {
  const parse = (raw: unknown): z.infer<S> => {
    const result = spec.args.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw new MutationRejected('BAD_ARGS', 'Invalid arguments', issues);
    }
    return result.data;
  };
  return {
    parse,
    reads: (raw) => spec.reads(parse(raw)),
    scans: (raw) => spec.scans?.(parse(raw)) ?? [],
    apply: (tx, raw, ctx) => spec.apply(tx, parse(raw), ctx),
  };
}
