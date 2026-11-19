import type { Row } from '../protocol/types';
import { WholeStateStorage, emptyState, newClientId, type WholeState } from './whole-state-storage';

interface LegacyBlob {
  cursor: unknown;
  lastMutationId: number;
  base: Record<string, Row>;
}

export class LocalStorageSyncStorage extends WholeStateStorage {
  constructor(private readonly key: string) {
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
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if ('nextMutationId' in parsed) return parsed;
    const converted = this.fromLegacy(parsed);
    this.write(converted);
    return converted;
  }

  protected write(state: WholeState): void {
    globalThis.localStorage.setItem(this.key, JSON.stringify(state));
  }

  // The starter's counter can be behind the server (saved only after a pull): a fresh client id starts both at 0.
  private fromLegacy(blob: LegacyBlob): WholeState {
    return {
      ...emptyState(newClientId()),
      cursor: typeof blob.cursor === 'string' ? (blob.cursor as WholeState['cursor']) : null,
      base: Object.entries(blob.base),
    };
  }
}
