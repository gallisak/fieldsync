import {
  TransportError,
  type EntityName,
  type Mutation,
  type PullParams,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type Row,
} from '@fieldsync/sync-core';
import type { AuthUser, SimServer } from '@fieldsync/sync-core/testing';
import { tokenHash } from '../../src/auth/token-hash';
import { ApiError } from '../../src/common/errors';
import { GcService } from '../../src/gc.service';
import { PullService } from '../../src/pull.service';
import { PushService } from '../../src/push.service';
import type { TestApp } from '../support/pg';

export class PgServer implements SimServer {
  applied: string[] = [];
  lastVersion = 0;
  private rejected = new Set<string>();
  private sent = new Map<string, Mutation>();
  private rows: { entity: EntityName; row: Row }[] = [];
  private firstWrite = new Map<string, number>();
  private dirty = true;
  private sites = new Set<string>();
  private userSites = new Map<string, Set<string>>();
  private readonly pushes: PushService;
  private readonly pulls: PullService;

  constructor(private readonly t: TestApp) {
    this.pushes = t.app.get(PushService);
    this.pulls = t.app.get(PullService);
  }

  get rejectedCount(): number {
    return this.rejected.size;
  }

  async push(user: AuthUser, req: PushRequest): Promise<PushResponse> {
    for (const m of req.mutations) this.sent.set(`${req.clientId}/${m.id}`, m);
    this.dirty = true;
    const res = await answer(() => this.pushes.push(user, req));
    for (const r of res.results) {
      const key = `${req.clientId}/${r.id}`;
      if (r.status === 'applied') this.applied.push(key);
      if (r.status === 'rejected') this.rejected.add(key);
    }
    return res;
  }

  pull(user: AuthUser, q: PullParams): Promise<PullResponse> {
    return answer(() =>
      this.pulls.pull(user, {
        cursor: q.cursor ?? undefined,
        clientId: q.clientId,
        ackedMutationId: q.ackedMutationId,
        limit: q.limit,
      }),
    );
  }

  async addSite(siteId: string): Promise<void> {
    this.sites.add(siteId);
    await this.t.pool.query(`INSERT INTO sites (id, name) VALUES ($1::uuid, $1::text)`, [siteId]);
  }

  async addUser(user: AuthUser): Promise<void> {
    await this.t.pool.query(
      `INSERT INTO users (id, name, role, token_hash) VALUES ($1::uuid, $1::text, $2, $3) ON CONFLICT DO NOTHING`,
      [user.id, user.role, tokenHash(user.id)],
    );
  }

  async grant(userId: string, siteId: string): Promise<void> {
    const sites = this.userSites.get(userId) ?? new Set<string>();
    sites.add(siteId);
    this.userSites.set(userId, sites);
    await this.t.pool.query(
      `INSERT INTO users (id, name, role, token_hash) VALUES ($1::uuid, $1::text, 'technician', $2) ON CONFLICT DO NOTHING`,
      [userId, tokenHash(userId)],
    );
    await this.t.pool.query(`INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      userId,
      siteId,
    ]);
  }

  async revoke(userId: string, siteId: string): Promise<void> {
    this.userSites.get(userId)?.delete(siteId);
    await this.t.pool.query(`DELETE FROM user_sites WHERE user_id = $1 AND site_id = $2`, [userId, siteId]);
  }

  async gc(cut: number): Promise<void> {
    this.dirty = true;
    await this.t.pool.query(`UPDATE change_log SET created_at = '2000-01-01' WHERE version <= $1`, [cut]);
    await this.t.app.get(GcService).collect();
  }

  sitesOf(user: AuthUser): Set<string> {
    return user.role === 'admin' ? new Set(this.sites) : new Set(this.userSites.get(user.id));
  }

  liveRows(entity?: EntityName): Row[] {
    return this.rows.filter((r) => !entity || r.entity === entity).map((r) => r.row);
  }

  expectedQuantities(): Map<string, number> {
    const live = new Set(this.liveRows('part').map((row) => String(row.id)));
    const applied = [...new Set(this.applied)].map((key) => this.sent.get(key));
    const expected = new Map<string, number>();
    for (const m of applied) {
      if (m?.name === 'part.add' && live.has(String(m.args.id)))
        expected.set(String(m.args.id), Number(m.args.quantity));
    }
    for (const m of applied) {
      const id = String(m?.args.id);
      if (m?.name === 'part.adjust' && expected.has(id))
        expected.set(id, (expected.get(id) ?? 0) + Number(m.args.delta));
    }
    return expected;
  }

  quantityOf(partId: string): number | undefined {
    return this.rows.find((r) => r.entity === 'part' && r.row.id === partId)?.row.quantity as number | undefined;
  }

  async refresh(): Promise<void> {
    if (!this.dirty) return;
    const { rows } = await this.t.pool.query<{
      entity: EntityName;
      id: string;
      data: Row;
      deleted: boolean;
      version: string;
      first: string | null;
    }>(
      `SELECT e.entity, e.id, e.data, e.deleted, e.version, f.first FROM entities e
         LEFT JOIN (SELECT entity, entity_id, min(version) AS first FROM change_log GROUP BY entity, entity_id) f
           ON f.entity = e.entity AND f.entity_id = e.id`,
    );
    const present = new Set<string>();
    for (const r of rows) {
      const key = `${r.entity}/${r.id}`;
      present.add(key);
      if (!this.firstWrite.has(key)) this.firstWrite.set(key, Number(r.first ?? r.version));
    }
    for (const key of this.firstWrite.keys()) if (!present.has(key)) this.firstWrite.delete(key);
    const first = (r: { entity: string; id: string }) => this.firstWrite.get(`${r.entity}/${r.id}`)!;
    this.rows = rows
      .filter((r) => !r.deleted)
      .sort((a, b) => first(a) - first(b))
      .map((r) => ({ entity: r.entity, row: r.data }));
    const state = await this.t.pool.query<{ last_version: string }>(`SELECT last_version FROM sync_state`);
    this.lastVersion = Number(state.rows[0].last_version);
    this.dirty = false;
  }

  async reset(): Promise<void> {
    await this.t.pool.query(`TRUNCATE entities, change_log, clients, mutation_rejections, user_sites, users, sites`);
    await this.t.pool.query(`UPDATE sync_state SET last_version = 0, min_retained_version = 0`);
    this.applied = [];
    this.lastVersion = 0;
    this.rejected = new Set();
    this.sent = new Map();
    this.rows = [];
    this.firstWrite = new Map();
    this.dirty = true;
    this.sites = new Set();
    this.userSites = new Map();
  }
}

async function answer<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError) throw new TransportError('http', err.status, err.code, err.details, err.message);
    throw err;
  }
}
