import type { Row } from '../protocol/types';
import { WholeStateStorage, emptyState, newClientId, type WholeState } from './whole-state-storage';

/** The blob the starter client stored: no queue, no client id (kept under its own key). */
interface LegacyBlob {
  cursor: unknown;
  lastMutationId: number;
  base: Record<string, Row>;
}

/**
 * Keeps the whole state as one JSON value in `localStorage`. Used by the web app until IndexedDB storage
 * replaces it (P3.5 / P8.3).
 */
export class LocalStorageSyncStorage extends WholeStateStorage {
  constructor(
    private readonly key: string,
    /** Where the starter web app kept its client id; adopted so the server keeps recognising this client. */
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
      return undefined; // unreadable: start over, as the starter did
    }
    if ('nextMutationId' in parsed) return parsed;
    // Converted once and written back, so every later read sees the same client id.
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
      // A v1 numeric cursor is meaningless to a v2 server: start over with a full pull.
      cursor: typeof blob.cursor === 'string' ? (blob.cursor as WholeState['cursor']) : null,
      lastMutationId: blob.lastMutationId,
      nextMutationId: blob.lastMutationId + 1,
      base: Object.entries(blob.base),
    };
  }
}
