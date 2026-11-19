import { decodeCursor, encodeCursor } from '@fieldsync/sync-core';
import type { PoolClient } from 'pg';
import { Db } from '../src/database/db.service';
import { GcService } from '../src/gc.service';
import { DEMO, TOKENS, pull, push, seed } from './support/api';
import { createTestApp, describeDb, type TestApp } from './support/pg';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

interface Explained {
  sql: string;
  nodes: PlanNode[];
}

const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];

describeDb('indexes serve the hot queries (EXPLAIN on 200k log rows over 50 sites)', () => {
  let t: TestApp;
  const explained: Explained[] = [];

  const recording = (c: PoolClient): PoolClient =>
    new Proxy(c, {
      get(target, prop) {
        if (prop !== 'query') return Reflect.get(target, prop);
        return async (text: string, values?: unknown[]) => {
          if (typeof text === 'string' && /^\s*(SELECT|DELETE)\b/i.test(text)) {
            const { rows } = await target.query(`EXPLAIN (FORMAT JSON) ${text}`, values);
            explained.push({ sql: text, nodes: flatten(rows[0]['QUERY PLAN'][0].Plan) });
          }
          return target.query(text, values);
        };
      },
    });

  const plansOf = (fragment: string): PlanNode[][] => {
    const found = explained.filter((e) => e.sql.includes(fragment)).map((e) => e.nodes);
    if (found.length === 0) throw new Error(`no query containing "${fragment}" ran`);
    return found;
  };

  const expectIndex = (fragment: string, index: string) => {
    for (const nodes of plansOf(fragment)) {
      expect(nodes.map((n) => n['Index Name']).filter(Boolean)).toContain(index);
      const seq = nodes.filter((n) => n['Node Type'] === 'Seq Scan').map((n) => n['Relation Name']);
      expect(seq).not.toContain('change_log');
      expect(seq).not.toContain('entities');
    }
  };

  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
    await t.pool.query(`
      INSERT INTO sites (id, name) SELECT gen_random_uuid(), 'site ' || n FROM generate_series(1, 48) n;
      CREATE TEMP TABLE s AS SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM sites;
      INSERT INTO users (id, name, role, token_hash)
        SELECT gen_random_uuid(), 'tech ' || n, 'technician', sha256(('t' || n)::bytea) FROM generate_series(1, 1000) n;
      INSERT INTO user_sites (user_id, site_id)
        SELECT u.id, s.id FROM users u JOIN s ON s.n % 10 = abs(hashtext(u.id::text)) % 10 WHERE u.role = 'technician'
        ON CONFLICT DO NOTHING;
      INSERT INTO entities (entity, id, site_id, data, deleted, version)
        SELECT 'ticket', gen_random_uuid(), s.id, jsonb_build_object('title', 'T'), g % 7 = 0, g * 10
          FROM generate_series(1, 20000) g JOIN s ON s.n = g % 50;
      INSERT INTO entities (entity, id, site_id, data, deleted, version)
        SELECT 'part', gen_random_uuid(), e.site_id, jsonb_build_object('ticketId', e.id, 'quantity', 1), e.deleted, e.version + 1
          FROM entities e;
      INSERT INTO change_log (version, tx_seq, site_id, entity, entity_id, op, data, created_at)
        SELECT g, g, s.id, 'ticket', gen_random_uuid(), 'put', '{}',
               CASE WHEN g <= 1000 THEN timestamptz '2000-01-01' ELSE now() END
          FROM generate_series(1, 200000) g JOIN s ON s.n = g % 50;
      UPDATE sync_state SET last_version = 200000;
      ANALYZE;
    `);
    const db = t.app.get(Db);
    const tx = db.tx.bind(db);
    jest.spyOn(db, 'tx').mockImplementation((fn, opts) => tx((c) => fn(recording(c)), opts));
  }, 120_000);

  afterAll(() => t?.close());

  it('access check: the user_sites primary key', async () => {
    await pull(t.http, TOKENS.techA, { clientId: 'explain-1' }).expect(200);
    for (const nodes of plansOf('FROM user_sites WHERE user_id')) {
      expect(nodes.map((n) => n['Index Name'])).toContain('user_sites_pkey');
    }
  });

  it('snapshot page: entities_snapshot_idx', async () => {
    await pull(t.http, TOKENS.techA, { clientId: 'explain-2' }).expect(200);
    expectIndex('ORDER BY e.entity, e.id', 'entities_snapshot_idx');
  });

  it('delta pull from an old cursor: change_log_site_version_idx, one range per site', async () => {
    const first = await pull(t.http, TOKENS.techA, { clientId: 'explain-3' }).expect(200);
    const fp = decodeCursor(first.body.cursor)!.fp;
    await pull(t.http, TOKENS.techA, { clientId: 'explain-3', cursor: encodeCursor({ k: 'd', v: 1000, fp }) }).expect(200);
    expectIndex('FROM change_log c', 'change_log_site_version_idx');
  });

  it("part scan of a deleted ticket: entities_part_ticket_idx", async () => {
    const { rows } = await t.pool.query<{ id: string }>(
      `SELECT id FROM entities WHERE entity = 'ticket' AND site_id = $1 AND NOT deleted LIMIT 1`,
      [DEMO.siteA],
    );
    const res = await push(t.http, TOKENS.techA, 'explain-4', [{ id: 1, name: 'ticket.delete', args: { id: rows[0].id } }]);
    expect(res.body.results[0].status).toBe('applied');
    expectIndex(`data->>'ticketId'`, 'entities_part_ticket_idx');
  });

  it('tombstone collection: entities_tombstone_idx', async () => {
    const result = await t.app.get(GcService).collect(new Date('2001-01-01'));
    expect(result?.log).toBe(1000);
    expectIndex('DELETE FROM entities WHERE deleted', 'entities_tombstone_idx');
  });
});
