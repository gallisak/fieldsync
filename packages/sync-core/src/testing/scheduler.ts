import type { SyncClock } from '../client/sync-client';

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

export class Scheduler {
  now = 0;

  /** `flush` lets work outside the virtual clock finish between steps, such as IndexedDB requests. */
  constructor(readonly flush: () => Promise<void> = settle) {}

  private seq = 0;
  private queue: { at: number; id: number; fn: () => unknown }[] = [];

  readonly clock: SyncClock = {
    now: () => this.now,
    setTimeout: (fn, ms) => this.at(this.now + ms, fn),
    clearTimeout: (handle) => {
      this.queue = this.queue.filter((e) => e.id !== handle);
    },
  };

  at(time: number, fn: () => unknown): number {
    const id = ++this.seq;
    this.queue.push({ at: time, id, fn });
    return id;
  }

  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.now = next.at;
      const result = next.fn();
      if (result instanceof Promise) await result;
      await this.flush();
    }
    this.now = end;
    await this.flush();
  }
}
