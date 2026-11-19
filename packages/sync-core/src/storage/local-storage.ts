import type { Row } from '../protocol/types';
import { WholeStateStorage, emptyState, newClientId, type WholeState } from './whole-state-storage';

interface LegacyBlob {
  cursor: unknown;
  lastMutationId: number;
  base: Record<string, Row>;
}

export class LocalStorageSyncStorage extends WholeStateStorage {
  constructor(
    private readonly key: string,
    private readonly legacyClientIdKey = 'fs_client_id',
  ) {
    super();
  }

  protected read(): WholeState | undefined {
    const raw = globalThis.localStorage.getItem(this.key);
    if (raw === null) return undefined;
    let parsed: WholeState | LegacyBlob;
    try {
      parsed = JSON.parse(raw) as WholeState | LegacyBlob;
    } catch {
      return undefined;
    }
    if ('nextMutationId' in parsed) return parsed;
    const converted = this.fromLegacy(parsed);
    this.write(converted);
    return converted;
  }

  protected write(state: WholeState): void {
    globalThis.localStorage.setItem(this.key, JSON.stringify(state));
  }

  private fromLegacy(blob: LegacyBlob): WholeState {
    const clientId = globalThis.localStorage.getItem(this.legacyClientIdKey) ?? newClientId();
    return {
      ...emptyState(clientId),
      cursor: typeof blob.cursor === 'string' ? (blob.cursor as WholeState['cursor']) : null,
      lastMutationId: blob.lastMutationId,
      nextMutationId: blob.lastMutationId + 1,
      base: Object.entries(blob.base),
    };
  }
}
