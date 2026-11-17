import type { PullResponse, PushRequest, PushResponse, Transport } from '../../src';

type Kind = 'push' | 'pull';

export type Reply<T> = T | Error | Promise<T> | (() => T | Error | Promise<T>);

export interface Call {
  kind: Kind;
  /** Every argument as passed, so tests survive signature changes (e.g. a trailing AbortSignal). */
  args: unknown[];
  at: number;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: Error): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Transport whose replies are queued per test. An empty queue falls back to the `always*` reply, or rejects
 * as if offline. After `maxCalls` calls every request hangs: a client that spins on resolved promises would
 * otherwise starve the event loop and hang the test instead of failing it.
 */
export class ScriptedTransport implements Transport {
  readonly calls: Call[] = [];
  private readonly queues: { push: Reply<PushResponse>[]; pull: Reply<PullResponse>[] } = { push: [], pull: [] };
  private readonly fallback: { push?: Reply<PushResponse>; pull?: Reply<PullResponse> } = {};

  constructor(private readonly maxCalls = 50) {}

  replyPush(...replies: Reply<PushResponse>[]): this {
    this.queues.push.push(...replies);
    return this;
  }

  replyPull(...replies: Reply<PullResponse>[]): this {
    this.queues.pull.push(...replies);
    return this;
  }

  alwaysPush(reply: Reply<PushResponse>): this {
    this.fallback.push = reply;
    return this;
  }

  alwaysPull(reply: Reply<PullResponse>): this {
    this.fallback.pull = reply;
    return this;
  }

  callsOf(kind: Kind): Call[] {
    return this.calls.filter((c) => c.kind === kind);
  }

  /** Mutations sent in every push so far, in order. */
  pushedMutations(): PushRequest['mutations'] {
    return this.callsOf('push').flatMap((c) => (c.args[0] as PushRequest).mutations);
  }

  push(...args: unknown[]): Promise<PushResponse> {
    return this.answer('push', args);
  }

  pull(...args: unknown[]): Promise<PullResponse> {
    return this.answer('pull', args);
  }

  private answer<T>(kind: Kind, args: unknown[]): Promise<T> {
    this.calls.push({ kind, args, at: Date.now() });
    if (this.calls.length > this.maxCalls) return new Promise<T>(() => undefined);
    const queue = this.queues[kind] as Reply<T>[];
    const reply = queue.length ? queue.shift() : (this.fallback[kind] as Reply<T> | undefined);
    if (reply === undefined) return Promise.reject(new Error(`offline: no scripted ${kind} reply`));
    const value = typeof reply === 'function' ? (reply as () => T | Error | Promise<T>)() : reply;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }
}

export const emptyPull = (lastMutationId = 0): PullResponse => ({
  changes: [],
  nextCursor: 0,
  hasMore: false,
  lastMutationId,
});

/** Lets pending promise chains run. Microtask-only, so it also works under fake timers. */
export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
