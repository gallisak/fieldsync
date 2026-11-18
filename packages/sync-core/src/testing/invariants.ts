import { CLIENT_INTERNALS } from '../client/internals';
import type { SyncClient } from '../client/sync-client';
import { decodeCursor } from '../protocol/cursor';
import type { Cursor, Row } from '../protocol/types';
import type { Device } from './harness';
import type { SimServer } from './server-port';

export interface At {
  seed: number;
  step: number;
  trace: readonly string[];
}

export class SimulationFailure extends Error {
  constructor(
    readonly at: At,
    readonly invariant: number,
    detail: string,
  ) {
    super(
      [`seed ${at.seed}, step ${at.step}: invariant ${invariant} violated: ${detail}`, 'last steps:']
        .concat(at.trace.slice(-30))
        .join('\n'),
    );
    this.name = 'SimulationFailure';
  }
}

export const baseRows = (client: SyncClient): Row[] => [...client[CLIENT_INTERNALS]().base.values()];

export const cursorOf = (client: SyncClient): Cursor | null => client[CLIENT_INTERNALS]().cursor;

const cursorVersion = (cursor: Cursor | null): number => (cursor ? (decodeCursor(cursor)?.v ?? 0) : 0);

export function canonical(rows: readonly Row[]): [string, string][] {
  const json = (row: Row) =>
    JSON.stringify(
      Object.keys(row)
        .sort()
        .map((k) => [k, row[k]]),
    );
  return rows
    .map((row): [string, string] => [String(row.id), json(row)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function difference(actual: [string, string][], expected: [string, string][]): string | undefined {
  const want = new Map(expected);
  const have = new Map(actual);
  const missing = [...want.keys()].filter((id) => !have.has(id));
  const extra = [...have.keys()].filter((id) => !want.has(id));
  const changed = [...want.keys()].filter((id) => have.has(id) && have.get(id) !== want.get(id));
  if (missing.length + extra.length + changed.length === 0) return undefined;
  const list = (ids: string[]) => ids.slice(0, 5).join(', ') + (ids.length > 5 ? ` … (${ids.length})` : '');
  return [
    missing.length ? `missing ${list(missing)}` : '',
    extra.length ? `extra ${list(extra)}` : '',
    changed.length ? `different ${list(changed)}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

const fail = (at: At, invariant: number, detail: string): never => {
  throw new SimulationFailure(at, invariant, detail);
};

export function checkSafety(server: SimServer, devices: Device[], at: At): void {
  const seen = new Set<string>();
  for (const key of server.applied) {
    if (seen.has(key)) fail(at, 2, `mutation ${key} applied twice`);
    seen.add(key);
  }
  for (const d of devices) {
    const client = d.tabs[0];
    if (!client) continue;
    for (const row of baseRows(client)) {
      if (!d.sitesAtLastPull.has(row.siteId as string)) {
        fail(at, 1, `device ${d.index} holds ${String(row.id)} of site ${String(row.siteId)}`);
      }
    }
    const v = cursorVersion(cursorOf(client));
    if (v < d.lastCursorVersion && !d.snapshotSinceLastCheck) {
      fail(at, 3, `device ${d.index} cursor ${d.lastCursorVersion} → ${v}`);
    }
    d.lastCursorVersion = v;
    d.snapshotSinceLastCheck = false;
  }
}

export function checkConvergence(server: SimServer, devices: Device[], at: At): void {
  const applied = new Set(server.applied);
  for (const d of devices) {
    const sites = server.sitesOf(d.user);
    const expected = canonical(server.liveRows().filter((row) => sites.has(row.siteId as string)));
    for (const [tab, client] of d.tabs.entries()) {
      const where = `device ${d.index} tab ${tab}`;
      const base = difference(canonical(baseRows(client)), expected);
      if (base) fail(at, 4, `${where}: base ≠ server: ${base}`);
      if (client.pendingCount !== 0) fail(at, 5, `${where}: ${client.pendingCount} still pending`);
      const view = difference(canonical([...client.view().values()]), expected);
      if (view) fail(at, 5, `${where}: view ≠ base: ${view}`);
    }
    // Keyed by the current client id: the simulated server never loses a client, so none is reset.
    const client = d.tabs[0];
    const rejected = new Set(client.rejections.map((r) => `${client.clientId}/${r.mutation.id}`));
    for (const key of d.issued) {
      if (applied.has(key) === rejected.has(key)) {
        fail(
          at,
          6,
          `device ${d.index}: ${key} is ${applied.has(key) ? 'both applied and rejected' : 'neither applied nor rejected'}`,
        );
      }
    }
  }
  for (const [partId, quantity] of server.expectedQuantities()) {
    const actual = server.quantityOf(partId);
    if (actual !== quantity) fail(at, 7, `part ${partId} has quantity ${actual}, expected ${quantity}`);
  }
}
