import type { Change, Cursor, Row } from '../protocol/types';
import type { PersistedState, PullCommit, StoredMutation, StoredRejection, SyncStorage } from './types';

/** The complete persisted state as plain, JSON-safe data. */
export interface WholeState {
  clientId: string;
  cursor: Cursor | null;
  lastMutationId: number;
  nextMutationId: number;
  base: [string, Row][];
  pending: StoredMutation[];
  rejections: StoredRejection[];
}

export const newClientId = (): string => globalThis.crypto.randomUUID();

export function emptyState(clientId: string): WholeState {
  return { clientId, cursor: null, lastMutationId: 0, nextMutationId: 1, base: [], pending: [], rejections: [] };
}

function applyChanges(base: Map<string, Row>, changes: Change[]): void {
  for (const c of changes) {
    const key = `${c.entity}/${c.id}`;
    if (c.op === 'put' && c.data) base.set(key, c.data);
    else base.delete(key);
  }
}

/**
 * The `SyncStorage` semantics, implemented once over a backend that reads and writes the whole state.
 * Each method reads, changes and writes with no `await` in between, so it is atomic for every client that
 * shares the backend.
 */
export abstract class WholeStateStorage implements SyncStorage {
  /** A private copy of the stored state, or `undefined` when nothing is stored yet. */
  protected abstract read(): WholeState | undefined;
  protected abstract write(state: WholeState): void;

  private current(): WholeState {
    const stored = this.read();
    if (stored) return stored;
    const fresh = emptyState(newClientId());
    this.write(fresh);
    return fresh;
  }

  async load(): Promise<PersistedState> {
    return toPersisted(this.current());
  }

  async enqueue(m: Omit<StoredMutation, 'id'>): Promise<StoredMutation> {
    const s = this.current();
    const stored: StoredMutation = { ...m, id: s.nextMutationId };
    s.pending.push(stored);
    s.nextMutationId += 1;
    this.write(s);
    return stored;
  }

  async commitPull(c: PullCommit): Promise<boolean> {
    const s = this.current();
    if (s.cursor !== c.expectedCursor) return false;

    const base = c.snapshot ? new Map<string, Row>() : new Map(s.base);
    applyChanges(base, c.snapshot ?? c.changes ?? []);
    s.base = [...base];
    s.cursor = c.cursor;

    if (c.lastMutationId !== null) {
      const acked = c.lastMutationId;
      const reasons = new Map(c.rejections.map((r) => [r.mutationId, r]));
      const at = new Date().toISOString();
      for (const m of s.pending) {
        const r = m.id <= acked ? reasons.get(m.id) : undefined;
        if (!r) continue;
        s.rejections.push({
          mutation: m,
          code: r.code,
          message: r.message,
          ...(r.details === undefined ? {} : { details: structuredClone(r.details) }),
          at,
        });
      }
      s.pending = s.pending.filter((m) => m.id > acked);
      // Never backwards: a lower value means the server lost this client or does not own it. The next push then
      // gets OUT_OF_ORDER / CLIENT_MISMATCH and the client starts over under a new id.
      s.lastMutationId = Math.max(s.lastMutationId, acked);
      // An id the server has acknowledged is never handed out again (F14).
      s.nextMutationId = Math.max(s.nextMutationId, s.lastMutationId + 1);
    }
    this.write(s);
    return true;
  }

  async dismissRejection(mutationId: number): Promise<void> {
    const s = this.current();
    s.rejections = s.rejections.filter((r) => r.mutation.id !== mutationId);
    this.write(s);
  }

  async resetClient(): Promise<PersistedState> {
    const s = this.current();
    s.clientId = newClientId();
    s.pending = s.pending.map((m, i) => ({ ...m, id: i + 1 }));
    s.nextMutationId = s.pending.length + 1;
    s.lastMutationId = 0;
    this.write(s);
    return toPersisted(s);
  }

  close(): void {}
}

function toPersisted(s: WholeState): PersistedState {
  return {
    clientId: s.clientId,
    cursor: s.cursor,
    lastMutationId: s.lastMutationId,
    base: new Map(s.base),
    pending: s.pending,
    rejections: s.rejections,
  };
}
