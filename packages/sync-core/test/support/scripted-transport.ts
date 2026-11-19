import type { Cursor, PullResponse, PushRequest, PushResponse, Transport } from '../../src';

type Kind = 'push' | 'pull';

export type Reply<T> = T | Error | Promise<T> | (() => T | Error | Promise<T>);

export interface Call {
  kind: Kind;
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

/** After `maxCalls` every request hangs, so a client that spins on resolved promises fails the test, not hangs it. */
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

export const emptyPull = (lastMutationId: number | null = 0): PullResponse => ({
  mode: 'delta',
  changes: [],
  cursor: 'test-cursor' as Cursor,
  hasMore: false,
  lastMutationId,
  rejections: [],
});

export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
