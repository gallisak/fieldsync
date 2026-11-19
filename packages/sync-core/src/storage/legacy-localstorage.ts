import { z } from 'zod';
import type { Row } from '../protocol/types';
import type { StoredMutation, StoredRejection } from './types';

export const LEGACY_STATE_KEY = 'fs_state';
export const LEGACY_CLIENT_ID_KEY = 'fs_client_id';

export type LegacySource = Pick<Storage, 'getItem' | 'removeItem'>;

export interface LegacyState {
  clientId?: string;
  lastMutationId: number;
  nextMutationId: number;
  base: [string, Row][];
  pending: StoredMutation[];
  rejections: StoredRejection[];
}

const count = z.number().int().min(0);
const row = z.looseObject({ siteId: z.string() });
const storedMutation = z.looseObject({
  id: z.number().int().positive(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const wholeState = z.object({
  clientId: z.string().min(1).optional(),
  lastMutationId: count,
  nextMutationId: z.number().int().positive(),
  base: z.array(z.tuple([z.string().regex(/^(ticket|part)\//), row])),
  pending: z.array(storedMutation),
  rejections: z.array(z.looseObject({ mutation: storedMutation, code: z.string(), message: z.string(), at: z.string() })),
});

const starterBlob = z.object({ lastMutationId: count, base: z.record(z.string().regex(/^(ticket|part)\//), row) });

/** Corrupt or unexpected data yields `undefined`: it runs inside the IndexedDB upgrade, where a throw aborts it. */
export function readLegacyState(source: LegacySource): LegacyState | undefined {
  const raw = source.getItem(LEGACY_STATE_KEY);
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const whole = wholeState.safeParse(parsed);
  if (whole.success) {
    const s = whole.data as unknown as LegacyState;
    return { ...s, clientId: s.clientId ?? source.getItem(LEGACY_CLIENT_ID_KEY) ?? undefined };
  }
  const starter = starterBlob.safeParse(parsed);
  if (!starter.success) return undefined;
  // The starter saved its counter only after a pull, so it can be behind the server: reusing that client id would
  // have new mutations answered as duplicates and dropped. A fresh client id starts both sides at 0.
  return {
    lastMutationId: 0,
    nextMutationId: 1,
    base: Object.entries(starter.data.base) as [string, Row][],
    pending: [],
    rejections: [],
  };
}

export function clearLegacyState(source: LegacySource): void {
  source.removeItem(LEGACY_STATE_KEY);
  source.removeItem(LEGACY_CLIENT_ID_KEY);
}
