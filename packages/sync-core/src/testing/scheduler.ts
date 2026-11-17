import type { SyncClock } from '../client/sync-client';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

/**
 * Virtual time: nothing ever waits for real time. There is no "run until idle", because clients re-arm their
 * poll timer forever; callers advance by a fixed amount of virtual time instead.
 */
export class Scheduler {
  now = 0;
  private seq = 0;
  private queue: { at: number; id: number; fn: () => void }[] = [];

  readonly clock: SyncClock = {
    now: () => this.now,
    setTimeout: (fn, ms) => this.at(this.now + ms, fn),
    clearTimeout: (handle) => {
      this.queue = this.queue.filter((e) => e.id !== handle);
    },
  };

  at(time: number, fn: () => void): number {
    const id = ++this.seq;
    this.queue.push({ at: time, id, fn });
    return id;
  }

  /** Runs every event due within the next `ms`, in (time, insertion) order. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.now = next.at;
      next.fn();
      await settle(); // let every promise chain started by the event finish before the next one
    }
    this.now = end;
    await settle();
  }
}
