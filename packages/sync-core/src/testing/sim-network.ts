import { TransportError } from '../transport/errors';
import type { Transport } from '../transport/http';
import { int } from './prng';
import type { Scheduler } from './scheduler';
import type { AuthUser, SyncServerPort } from './server-port';

/** The probability of each fate per call; every hop takes 1 … `maxDelayMs` of virtual time. */
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

/**
 * A lossy network with one `Transport` per client. Every call draws its fate and delays from the seeded
 * generator, so a seed replays the same losses, duplicates and reorderings at the same virtual times.
 */
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
            this.server.push(user, { ...structuredClone(req), mutations: structuredClone(prefix) });
          },
        ),
      pull: (q, signal) => this.call(client, signal, () => this.server.pull(user, structuredClone(q))),
    };
  }

  /** `partial` delivers part of the request to the server, as when the connection is cut mid-batch. */
  private call<T>(client: number, signal: AbortSignal | undefined, exec: () => T, partial?: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      // Giving up does not unsend the request: the server may still execute it, only the answer is ignored.
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
      if (roll < edge) return void fail(d1); // the server never sees it

      s.at(s.now + d1, () => {
        if (partial && roll < (edge += f.cut)) {
          try {
            partial();
          } catch {
            // its answer is lost with the connection
          }
          return void fail(d2);
        }
        let out: { ok: T } | { err: unknown };
        try {
          out = { ok: structuredClone(exec()) };
        } catch (err) {
          out = { err };
        }
        if (roll < (edge += f.dropResponse) || this.offline.has(client)) return void fail(d2);
        if (roll < (edge += f.duplicate)) {
          s.at(s.now + d3, () => {
            try {
              exec();
            } catch {
              // a replay's answer goes nowhere
            }
          });
        }
        s.at(s.now + d2, () => finish(() => ('err' in out ? reject(out.err) : resolve(out.ok))));
      });
    });
  }
}
