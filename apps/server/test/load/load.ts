import '../support/env';
import { baseOf, baseRows, canonical, mulberry32 } from '@fieldsync/sync-core/testing';
import type { Row } from '@fieldsync/sync-core';
import { randomBytes, randomUUID } from 'crypto';
import { cpus, totalmem, type as osType, release } from 'os';
import { monitorEventLoopDelay } from 'perf_hooks';
import { Pool } from 'pg';
import { tokenHash } from '../../src/auth/token-hash';
import { Device, type LoadStats } from './device';

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  return raw ? Number(raw) : fallback;
};

const CLIENTS = num('LOAD_CLIENTS', 200);
const SITES = num('LOAD_SITES', 10);
const DURATION_MS = num('LOAD_DURATION_S', 600) * 1_000;
const SEED = num('LOAD_SEED', 1);
const HEAL_TIMEOUT_MS = num('LOAD_HEAL_TIMEOUT_S', 180) * 1_000;
const API_URL = process.env.LOAD_API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;

type Samples = Map<string, number>;

async function scrape(): Promise<Samples> {
  const token = process.env.METRICS_TOKEN;
  const res = await fetch(`${API_URL}/metrics`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`/metrics answered ${res.status}`);
  const samples: Samples = new Map();
  for (const line of (await res.text()).split('\n')) {
    const m = /^(fieldsync_[a-z_]+(?:\{[^}]*\})?) (\S+)$/.exec(line);
    if (m) samples.set(m[1], Number(m[2]));
  }
  return samples;
}

const diff = (after: Samples, before: Samples): Samples =>
  new Map([...after].map(([k, v]) => [k, v - (before.get(k) ?? 0)]));

const labelled = (samples: Samples, metric: string): [string, number][] =>
  [...samples]
    .filter(([k, v]) => k.startsWith(`${metric}{`) && v !== 0)
    .map(([k, v]): [string, number] => [k.slice(k.indexOf('"') + 1, k.lastIndexOf('"')), v]);

function bucketQuantile(samples: Samples, metric: string, q: number): string {
  const buckets = [...samples]
    .filter(([k]) => k.startsWith(`${metric}_bucket{`))
    .map(([k, v]): [string, number] => [/le="([^"]+)"/.exec(k)![1], v]);
  const count = samples.get(`${metric}_count`) ?? 0;
  if (count === 0) return 'n/a';
  const hit = buckets.find(([, v]) => v >= q * count);
  return hit ? `≤ ${hit[0]} s` : 'n/a';
}

function percentile(values: number[], q: number): string {
  if (values.length === 0) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  return `${Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])} ms`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const table = (rows: [string, string | number][]) => rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const tag = randomBytes(3).toString('hex');
  const sites = Array.from({ length: SITES }, () => randomUUID());
  const users = Array.from({ length: CLIENTS }, (_, i) => ({
    id: randomUUID(),
    token: `load-${tag}-${i}`,
    site: sites[i % SITES],
  }));
  await pool.query(`INSERT INTO sites (id, name) SELECT id, 'load ' || $2 || ' site ' || n FROM unnest($1::uuid[]) WITH ORDINALITY AS s(id, n)`, [sites, tag]);
  await pool.query(
    `INSERT INTO users (id, name, role, token_hash) SELECT id, 'load ' || $3 || ' tech ' || n, 'technician', hash
       FROM unnest($1::uuid[], $2::bytea[]) WITH ORDINALITY AS u(id, hash, n)`,
    [users.map((u) => u.id), users.map((u) => tokenHash(u.token)), tag],
  );
  await pool.query(`INSERT INTO user_sites (user_id, site_id) SELECT * FROM unnest($1::uuid[], $2::uuid[])`, [
    users.map((u) => u.id),
    users.map((u) => u.site),
  ]);

  const stats: LoadStats = {
    issued: 0,
    localRefusals: new Map(),
    pushResults: new Map(),
    rejected: new Map(),
    snapshots: new Map(),
    probes: new Map(),
    lagFromMutate: [],
    lagFromPush: [],
  };
  const devices = users.map(
    (u, i) => new Device(i, u.site, API_URL, u.token, mulberry32(SEED * 100_003 + i), mulberry32(SEED * 7_919 + i + 1), stats),
  );
  for (const d of devices) {
    d.client.subscribe(() => {
      const probes = stats.probes.get(d.siteId);
      if (!probes?.length) return;
      const base = baseOf(d.client);
      const now = Date.now();
      for (let i = probes.length - 1; i >= 0; i--) {
        const p = probes[i];
        if (p.author === d || !p.seen(base)) continue;
        stats.lagFromMutate.push(now - p.issuedAt);
        if (p.lastPushAt !== undefined) stats.lagFromPush.push(now - p.lastPushAt);
        probes.splice(i, 1);
        p.author.pendingProbes.delete(p.key);
      }
    });
  }

  const before = await scrape();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const started = Date.now();
  log(`run ${tag}: ${CLIENTS} clients over ${SITES} sites for ${DURATION_MS / 1_000} s against ${API_URL}, seed ${SEED}`);
  devices.forEach((d, i) => setTimeout(() => d.start(), (i * 10_000) / CLIENTS));
  const progress = setInterval(() => {
    const offline = devices.filter((d) => !d.link.online).length;
    const pending = devices.reduce((n, d) => n + d.client.pendingCount, 0);
    log(`${Math.round((Date.now() - started) / 1_000)} s: issued ${stats.issued}, offline ${offline}, pending ${pending}, delivered probes ${stats.lagFromMutate.length}`);
  }, 30_000);
  await sleep(DURATION_MS);
  const ended = Date.now();
  for (const d of devices) {
    d.stopActing();
    d.heal(ended);
  }
  loop.disable();

  log('healing: every device online, waiting for convergence');
  const healed = await converge(pool, devices, sites);
  clearInterval(progress);
  const healMs = Date.now() - ended;
  const after = await scrape();
  const delta = diff(after, before);
  const { rows: logRows } = await pool.query<{ run: string; total: string }>(
    `SELECT count(*) FILTER (WHERE site_id = ANY($1)) AS run, count(*) AS total FROM change_log`,
    [sites],
  );
  const { rows: pg } = await pool.query<{ version: string }>(`SELECT version()`);

  const rejectedByCode = new Map<string, number>();
  for (const code of stats.rejected.values()) rejectedByCode.set(code, (rejectedByCode.get(code) ?? 0) + 1);
  const storedRejections = devices.reduce((n, d) => n + d.client.rejections.length, 0);
  const offlineShare = devices.reduce((n, d) => n + d.offlineMs, 0) / (CLIENTS * (ended - started));
  const undelivered = [...stats.probes.values()].reduce((n, l) => n + l.length, 0);
  const cpu = cpus();

  const report = [
    `## Load run ${tag}`,
    '',
    `Command: \`LOAD_SEED=${SEED} LOAD_CLIENTS=${CLIENTS} LOAD_SITES=${SITES} LOAD_DURATION_S=${DURATION_MS / 1_000} npm run load\``,
    '',
    table([
      ['Machine', `${osType()} ${release()}, ${cpu[0]?.model} × ${cpu.length}, ${Math.round(totalmem() / 2 ** 30)} GiB`],
      ['Node (load process)', process.version],
      ['Postgres', pg[0].version.split(',')[0]],
      ['Clients / sites / duration', `${CLIENTS} / ${SITES} / ${DURATION_MS / 1_000} s`],
      ['Time offline (measured)', `${(offlineShare * 100).toFixed(1)}%`],
      ['Mutations issued', stats.issued],
      ['Refused locally before queueing', [...stats.localRefusals].map(([c, n]) => `${c} ${n}`).join(', ') || 0],
      ['Push results (incl. retries)', [...stats.pushResults].map(([s, n]) => `${s} ${n}`).join(', ')],
      ['Rejected by the server', [...rejectedByCode].map(([c, n]) => `${c} ${n}`).join(', ') || 0],
      ['Rejections held by clients after healing', storedRejections],
      ['Snapshots (first page, by reason)', [...stats.snapshots].map(([r, n]) => `${r} ${n}`).join(', ')],
      ['Delivery lag from `mutate()`, p50 / p95 / p99', ['0.5', '0.95', '0.99'].map((q) => percentile(stats.lagFromMutate, Number(q))).join(' / ')],
      ['Delivery lag from the push that carried it, p50 / p95 / p99', ['0.5', '0.95', '0.99'].map((q) => percentile(stats.lagFromPush, Number(q))).join(' / ')],
      ['Changes measured / overwritten or deleted before anyone pulled', `${stats.lagFromMutate.length} / ${undelivered}`],
      ['Server `fieldsync_delivery_lag_seconds` p50 / p95 / p99', ['0.5', '0.95', '0.99'].map((q) => bucketQuantile(delta, 'fieldsync_delivery_lag_seconds', Number(q))).join(' / ')],
      ['Server `fieldsync_mutations_total`', labelled(delta, 'fieldsync_mutations_total').map(([s, n]) => `${s} ${n}`).join(', ')],
      ['Server `fieldsync_mutations_rejected_total`', labelled(delta, 'fieldsync_mutations_rejected_total').map(([c, n]) => `${c} ${n}`).join(', ') || 0],
      ['Server `fieldsync_full_resyncs_total`', labelled(delta, 'fieldsync_full_resyncs_total').map(([r, n]) => `${r} ${n}`).join(', ')],
      ['Push duration p95 (server)', bucketQuantile(delta, 'fieldsync_push_duration_seconds', 0.95)],
      ['`change_log` rows: this run / whole table', `${logRows[0].run} / ${logRows[0].total}`],
      ['Server `fieldsync_change_log_rows`', after.get('fieldsync_change_log_rows') ?? 'n/a'],
      ['Load process event-loop delay p99 / max', `${Math.round(loop.percentile(99) / 1e6)} ms / ${Math.round(loop.max / 1e6)} ms`],
      ['Healing to convergence', healed ? `${(healMs / 1_000).toFixed(1)} s, every base equals the server` : 'FAILED'],
    ]),
  ].join('\n');
  process.stdout.write(`\n${report}\n`);

  for (const d of devices) d.client.dispose();
  await pool.end();
  if (!healed) process.exitCode = 1;
}

/** Simulator invariant 4 (and 5): once nothing is pending, every base equals the server's live rows of its site. */
async function converge(pool: Pool, devices: Device[], sites: string[]): Promise<boolean> {
  const deadline = Date.now() + HEAL_TIMEOUT_MS;
  let failure = '';
  while (Date.now() < deadline) {
    await sleep(1_000);
    const pending = devices.filter((d) => d.client.pendingCount > 0).length;
    if (pending > 0) {
      failure = `${pending} devices still have pending mutations`;
      for (const d of devices) void d.client.sync();
      continue;
    }
    const { rows } = await pool.query<{ site_id: string; data: Row }>(
      `SELECT site_id, data FROM entities WHERE NOT deleted AND site_id = ANY($1)`,
      [sites],
    );
    const expected = new Map(sites.map((s) => [s, JSON.stringify(canonical(rows.filter((r) => r.site_id === s).map((r) => r.data)))]));
    const behind = devices.filter(
      (d) =>
        JSON.stringify(canonical(baseRows(d.client))) !== expected.get(d.siteId) ||
        JSON.stringify(canonical([...d.client.view().values()])) !== expected.get(d.siteId),
    );
    if (behind.length === 0) return true;
    failure = `${behind.length} devices differ from the server (first: device ${behind[0].index})`;
    for (const d of behind) void d.client.sync();
  }
  log(`convergence failed: ${failure}`);
  return false;
}

function log(line: string): void {
  process.stdout.write(`[load] ${line}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
