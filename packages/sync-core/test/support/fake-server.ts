import {
  MutationRejected,
  TransportError,
  getMutator,
  type Change,
  type Cursor,
  type EntityName,
  type MutationResult,
  type MutatorTx,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type Row,
  type Transport,
} from '../../src';

export class FakeServer {
  readonly state = new Map<string, Row>();
  readonly log: Change[] = [];
  readonly applied: string[] = [];
  duplicates = 0;
  private readonly clients = new Map<string, number>();

  push(req: PushRequest): PushResponse {
    const results: MutationResult[] = [];
    for (const m of req.mutations) {
      const last = this.clients.get(req.clientId) ?? 0;
      if (m.id <= last) {
        this.duplicates += 1;
        results.push({ id: m.id, status: 'duplicate' });
        continue;
      }
      if (m.id !== last + 1) throw new TransportError('http', 409, 'OUT_OF_ORDER', { expected: last + 1 });
      const writes: Change[] = [];
      const tx: MutatorTx = {
        get: (entity, id) => this.state.get(`${entity}/${id}`),
        exists: (entity, id) => this.state.has(`${entity}/${id}`),
        scan: (entity, by) => [...this.state.values()].filter((r) => r.ticketId === by.ticketId && entity === 'part'),
        put: (entity: EntityName, id, row) => writes.push(this.change(entity, id, 'put', row)),
        del: (entity: EntityName, id) => writes.push(this.change(entity, id, 'del', null)),
      };
      try {
        getMutator(m.name)?.apply(tx, m.args, { now: '2026-01-01T10:00:00.000Z' });
        for (const w of writes) {
          if (w.op === 'put') this.state.set(`${w.entity}/${w.id}`, w.data!);
          else this.state.delete(`${w.entity}/${w.id}`);
          this.log.push({ ...w, version: this.log.length + 1 });
        }
        this.applied.push(`${req.clientId}/${m.id}`);
        results.push({ id: m.id, status: 'applied' });
      } catch (err) {
        if (!(err instanceof MutationRejected)) throw err;
        results.push({ id: m.id, status: 'rejected', code: err.code, message: err.message });
      }
      this.clients.set(req.clientId, m.id);
    }
    return { results, lastMutationId: this.clients.get(req.clientId) ?? 0 };
  }

  pull(cursor: Cursor | null, clientId: string): PullResponse {
    const from = cursor ? Number(cursor) : 0;
    return {
      mode: 'delta',
      changes: this.log.slice(from),
      cursor: String(this.log.length) as Cursor,
      hasMore: false,
      lastMutationId: this.clients.get(clientId) ?? 0,
      rejections: [],
    };
  }

  transport(opts: { holdPush?: () => boolean } = {}): Transport & { calls: number } {
    const t = {
      calls: 0,
      push: async (req: PushRequest) => {
        t.calls += 1;
        const res = this.push(req);
        if (opts.holdPush?.()) return new Promise<PushResponse>(() => undefined);
        return res;
      },
      pull: async (params: { cursor: Cursor | null; clientId: string }) => {
        t.calls += 1;
        return this.pull(params.cursor, params.clientId);
      },
    };
    return t;
  }

  private change(entity: EntityName, id: string, op: 'put' | 'del', data: Row | null): Change {
    return { version: 0, entity, id, siteId: String(data?.siteId ?? ''), op, data };
  }
}
