import { TransportError } from '../transport/errors';
import type { Transport } from '../transport/http';
import { int } from './prng';
import type { Scheduler } from './scheduler';
import type { AuthUser, SyncServerPort } from './server-port';

export interface Faults {
  dropRequest: number;
  dropResponse: number;
  duplicate: number;
  cut: number;
  maxDelayMs: number;
}

export const DEFAULT_FAULTS: Faults = {
  dropRequest: 0.05,
  dropResponse: 0.05,
  duplicate: 0.05,
  cut: 0.03,
  maxDelayMs: 400,
};

export class SimNetwork {
  private readonly offline = new Set<number>();

  constructor(
    private readonly rng: () => number,
    private readonly s: Scheduler,
    private readonly server: SyncServerPort,
    public faults: Faults,
  ) {}

  setOffline(client: number, off: boolean): void {
    if (off) this.offline.add(client);
    else this.offline.delete(client);
  }

  isOffline(client: number): boolean {
    return this.offline.has(client);
  }

  heal(): void {
    this.offline.clear();
    this.faults = { dropRequest: 0, dropResponse: 0, duplicate: 0, cut: 0, maxDelayMs: 5 };
  }

  transportFor(client: number, user: AuthUser): Transport {
    return {
      push: (req, signal) =>
        this.call(
          client,
          signal,
          () => this.server.push(user, structuredClone(req)),
          () => {
            const prefix = req.mutations.slice(0, int(this.rng, req.mutations.length));
            return this.server.push(user, { ...structuredClone(req), mutations: structuredClone(prefix) });
          },
        ),
      pull: (q, signal) => this.call(client, signal, () => this.server.pull(user, structuredClone(q))),
    };
  }

  private call<T>(
    client: number,
    signal: AbortSignal | undefined,
    exec: () => T | Promise<T>,
    partial?: () => unknown,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => reject(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (fn: () => void) => {
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const { s, rng, faults: f } = this;
      const fail = (ms: number) => s.at(s.now + ms, () => finish(() => reject(new TransportError('network'))));
      if (this.offline.has(client)) return void fail(1);
      const roll = rng();
      const d1 = 1 + int(rng, f.maxDelayMs);
      const d2 = 1 + int(rng, f.maxDelayMs);
      const d3 = 1 + int(rng, f.maxDelayMs);
      let edge = f.dropRequest;
      if (roll < edge) return void fail(d1);

      s.at(s.now + d1, () => {
        if (partial && roll < (edge += f.cut)) return after(partial, () => void fail(d2));
        return after(exec, (outcome) => {
          const out = 'ok' in outcome ? { ok: structuredClone(outcome.ok) } : outcome;
          if (roll < (edge += f.dropResponse) || this.offline.has(client)) return void fail(d2);
          if (roll < (edge += f.duplicate)) s.at(s.now + d3, () => after(exec, () => undefined));
          s.at(s.now + d2, () => finish(() => ('err' in out ? reject(out.err) : resolve(out.ok))));
        });
      });
    });
  }
}

type Outcome<T> = { ok: T } | { err: unknown };

function after<T>(f: () => T | Promise<T>, then: (out: Outcome<T>) => void): void | Promise<void> {
  let result: T | Promise<T>;
  try {
    result = f();
  } catch (err) {
    return then({ err });
  }
  if (result instanceof Promise)
    return result.then(
      (ok: T) => then({ ok }),
      (err: unknown) => then({ err }),
    );
  return then({ ok: result });
}
