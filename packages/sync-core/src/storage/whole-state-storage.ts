import type { Change, Cursor, Row } from '../protocol/types';
import type { PersistedState, PullCommit, StoredMutation, StoredRejection, SyncStorage } from './types';

export interface WholeState {
  clientId: string;
  cursor: Cursor | null;
  lastMutationId: number;
  nextMutationId: number;
  base: [string, Row][];
  pending: StoredMutation[];
  rejections: StoredRejection[];
  nextRejectionId?: number;
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

/** No `await` between a method's read and its write: that is what makes each method atomic across tabs. */
export abstract class WholeStateStorage implements SyncStorage {
  private readonly newId: () => string;

  constructor(opts: { idGen?: () => string } = {}) {
    this.newId = opts.idGen ?? newClientId;
  }

  protected abstract read(): WholeState | undefined;
  protected abstract write(state: WholeState): void;

  private current(): WholeState {
    const stored = this.read();
    if (stored) return withRejectionIds(stored);
    const fresh = emptyState(this.newId());
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
        const id = s.nextRejectionId ?? 1;
        s.nextRejectionId = id + 1;
        s.rejections.push({
          id,
          mutation: m,
          code: r.code,
          message: r.message,
          ...(r.details === undefined ? {} : { details: structuredClone(r.details) }),
          at,
        });
      }
      s.pending = s.pending.filter((m) => m.id > acked);
      // Never backwards: a lower value means the server lost this client or does not own it.
      s.lastMutationId = Math.max(s.lastMutationId, acked);
      s.nextMutationId = Math.max(s.nextMutationId, s.lastMutationId + 1);
    }
    this.write(s);
    return true;
  }

  async dismissRejection(rejectionId: number): Promise<void> {
    const s = this.current();
    s.rejections = s.rejections.filter((r) => r.id !== rejectionId);
    this.write(s);
  }

  async resetClient(): Promise<PersistedState> {
    const s = this.current();
    s.clientId = this.newId();
    s.pending = s.pending.map((m, i) => ({ ...m, id: i + 1 }));
    s.nextMutationId = s.pending.length + 1;
    s.lastMutationId = 0;
    this.write(s);
    return toPersisted(s);
  }

  close(): void {}
}

// State written before rejections had their own id.
function withRejectionIds(s: WholeState): WholeState {
  let next = Math.max(s.nextRejectionId ?? 1, ...s.rejections.map((r) => (r.id ?? 0) + 1));
  s.rejections = s.rejections.map((r) => (r.id === undefined ? { ...r, id: next++ } : r));
  s.nextRejectionId = next;
  return s;
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
