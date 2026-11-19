import type { Row } from '@fieldsync/sync-core';
import { DEFAULT_FAULTS, ModelServer, runSimulation, type SimConfig } from '@fieldsync/sync-core/testing';
import type { Pool } from 'pg';
import { createTestApp, describeDb, type TestApp } from '../support/pg';
import { PgServer } from './pg-server';

const FLAGS: SimConfig['flags'] = { crash: true, tabs: true, access: true, gc: true };
const STEPS = 200;
const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
const DIFFERENTIAL_SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);

const config = (seed: number): SimConfig => ({ seed, steps: STEPS, clients: 3, faults: DEFAULT_FAULTS, flags: FLAGS });

interface ServerDump {
  lastVersion: number;
  entities: Record<string, { siteId: string; version: number; row: Row | null }>;
  clients: Record<string, number>;
  rejections: Record<string, string>;
}

const untimed = (row: Row | null | undefined): Row | null =>
  row ? Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'createdAt' && k !== 'updatedAt')) : null;

function dumpModel(m: ModelServer): ServerDump {
  return {
    lastVersion: m.lastVersion,
    entities: Object.fromEntries(
      [...m.entities].map(([key, e]) => [key, { siteId: e.siteId, version: e.version, row: untimed(e.row) }]),
    ),
    clients: Object.fromEntries([...m.clients].map(([id, c]) => [id, c.last])),
    rejections: Object.fromEntries([...m.rejections].map(([key, r]) => [key, r.code])),
  };
}

async function dumpPg(pool: Pool): Promise<ServerDump> {
  const state = await pool.query<{ last_version: string }>(`SELECT last_version FROM sync_state`);
  const entities = await pool.query<{ entity: string; id: string; site_id: string; version: string; data: Row | null }>(
    `SELECT entity, id, site_id, version, CASE WHEN deleted THEN NULL ELSE data END AS data FROM entities`,
  );
  const clients = await pool.query<{ client_id: string; last_mutation_id: string }>(
    `SELECT client_id, last_mutation_id FROM clients`,
  );
  const rejections = await pool.query<{ client_id: string; mutation_id: string; code: string }>(
    `SELECT client_id, mutation_id, code FROM mutation_rejections`,
  );
  return {
    lastVersion: Number(state.rows[0].last_version),
    entities: Object.fromEntries(
      entities.rows.map((e) => [
        `${e.entity}/${e.id}`,
        { siteId: e.site_id, version: Number(e.version), row: untimed(e.data) },
      ]),
    ),
    clients: Object.fromEntries(clients.rows.map((c) => [c.client_id, Number(c.last_mutation_id)])),
    rejections: Object.fromEntries(rejections.rows.map((r) => [`${r.client_id}/${r.mutation_id}`, r.code])),
  };
}

describeDb('simulation against Postgres', () => {
  let t: TestApp;
  let pg: PgServer;
  beforeAll(async () => {
    t = await createTestApp();
    pg = new PgServer(t);
  });
  afterAll(() => t?.close());

  const runPg = async (seed: number) => {
    await pg.reset();
    return runSimulation(config(seed), () => pg);
  };

  it.each(SEEDS)('seed %i keeps every invariant', (seed) => runPg(seed).then(() => undefined), 60_000);

  it('replays a seed exactly', async () => {
    expect(await runPg(7)).toEqual(await runPg(7));
  }, 60_000);

  it.each(DIFFERENTIAL_SEEDS)(
    'seed %i: Postgres and the model take the same steps and end in the same state',
    async (seed) => {
      let model: ModelServer | undefined;
      const fromModel = await runSimulation(config(seed), (clock) => (model = new ModelServer(clock)));
      const fromPg = await runPg(seed);
      expect(fromPg).toEqual(fromModel);
      expect(await dumpPg(t.pool)).toEqual(dumpModel(model as ModelServer));
    },
    60_000,
  );
});
