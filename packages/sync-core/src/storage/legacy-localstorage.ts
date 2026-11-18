import type { Row } from '../protocol/types';
import type { StoredMutation, StoredRejection } from './types';
import type { WholeState } from './whole-state-storage';

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

interface StarterBlob {
  cursor: unknown;
  lastMutationId: number;
  base: Record<string, Row>;
}

export function readLegacyState(source: LegacySource): LegacyState | undefined {
  const raw = source.getItem(LEGACY_STATE_KEY);
  if (raw === null) return undefined;
  let parsed: WholeState | StarterBlob;
  try {
    parsed = JSON.parse(raw) as WholeState | StarterBlob;
  } catch {
    return undefined;
  }
  const legacyClientId = source.getItem(LEGACY_CLIENT_ID_KEY) ?? undefined;
  if ('nextMutationId' in parsed) {
    return {
      clientId: parsed.clientId ?? legacyClientId,
      lastMutationId: parsed.lastMutationId,
      nextMutationId: parsed.nextMutationId,
      base: parsed.base,
      pending: parsed.pending,
      rejections: parsed.rejections,
    };
  }
  return {
    clientId: legacyClientId,
    lastMutationId: parsed.lastMutationId,
    nextMutationId: parsed.lastMutationId + 1,
    base: Object.entries(parsed.base),
    pending: [],
    rejections: [],
  };
}

export function clearLegacyState(source: LegacySource): void {
  source.removeItem(LEGACY_STATE_KEY);
  source.removeItem(LEGACY_CLIENT_ID_KEY);
}
