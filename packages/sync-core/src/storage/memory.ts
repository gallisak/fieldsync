import type { Cursor, Row } from '../protocol/types';

export interface Persisted {
  cursor: Cursor | null;
  lastMutationId: number;
  base: Record<string, Row>;
}

export interface SyncStorage {
  load(): Persisted | null;
  save(state: Persisted): void;
}

export class MemoryStorage implements SyncStorage {
  private state: Persisted | null = null;

  load(): Persisted | null {
    return this.state ? structuredClone(this.state) : null;
  }

  save(state: Persisted): void {
    this.state = structuredClone(state);
  }
}

export class LocalStorageSyncStorage implements SyncStorage {
  constructor(private readonly key: string) {}

  load(): Persisted | null {
    try {
      const raw = globalThis.localStorage.getItem(this.key);
      return raw ? (JSON.parse(raw) as Persisted) : null;
    } catch {
      return null;
    }
  }

  save(state: Persisted): void {
    try {
      globalThis.localStorage.setItem(this.key, JSON.stringify(state));
    } catch {
      // Storage may be full or unavailable; the client keeps working in memory.
    }
  }
}
