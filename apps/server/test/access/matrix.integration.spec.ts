import { PROTOCOL, PROTOCOL_HEADER, encodeCursor, type Change, type MutatorName } from '@fieldsync/sync-core';
import { randomUUID } from 'crypto';
import { DEMO, TOKENS, listen, openStream, seed } from '../support/api';
import { createTestApp, describeDb, until, type TestApp } from '../support/pg';

const A = DEMO.siteA;
const B = DEMO.siteB;

interface Caller {
  name: string;
  token?: string;
  sites: string[];
}
const AUTHENTICATED: Caller[] = [
  { name: 'admin', token: TOKENS.admin, sites: [A, B] },
  { name: 'techA', token: TOKENS.techA, sites: [A] },
  { name: 'techB', token: TOKENS.techB, sites: [B] },
];
const UNAUTHENTICATED: Caller[] = [
  { name: 'no token', sites: [] },
  { name: 'wrong token', token: 'not-a-token', sites: [] },
];

interface Fixture {
  site: string;
  ticket: string;
  part: string;
}

const MUTATORS: Record<
  MutatorName,
  (f: Fixture, caller: Caller) => { args: Record<string, unknown>; creates?: string }
> = {
  'ticket.create': (f) => {
    const id = randomUUID();
    return { args: { id, siteId: f.site, title: 'matrix', description: '' }, creates: id };
  },
  'ticket.update': (f) => ({ args: { id: f.ticket, patch: { title: 'changed' } } }),
  'ticket.setStatus': (f) => ({ args: { id: f.ticket, from: 'open', to: 'in_progress' } }),
  'ticket.delete': (f) => ({ args: { id: f.ticket } }),
  'ticket.move': (f, caller) => ({
    args: { id: f.ticket, toSiteId: caller.sites.find((s) => s !== f.site) ?? caller.sites[0] },
  }),
  'part.add': (f) => {
    const id = randomUUID();
    return { args: { id, ticketId: f.ticket, name: 'belt', quantity: 1 }, creates: id };
  },
  'part.adjust': (f) => ({ args: { id: f.part, delta: 1 } }),
};
const NAMES = Object.keys(MUTATORS) as MutatorName[];

describeDb('access matrix', () => {
  let t: TestApp;
  let baseUrl: string;
  let adminSeq = 0;

  const request = (method: 'get' | 'post', path: string, caller: Caller) => {
    const r = t.http[method](path).set(PROTOCOL_HEADER, String(PROTOCOL));
    return caller.token === undefined ? r : r.set('authorization', `Bearer ${caller.token}`);
  };
  const pull = (caller: Caller, cursor?: string) =>
    request('get', '/sync/pull', caller).query(cursor ? { cursor } : {});
  const asAdmin = async (name: MutatorName, args: Record<string, unknown>) => {
    const res = await request('post', '/sync/push', AUTHENTICATED[0]).send({
      clientId: 'matrix-admin',
      mutations: [{ id: ++adminSeq, name, args }],
    });
    expect(res.body.results?.[0]?.status).toBe('applied');
  };
  const newTicket = async (site: string) => {
    const id = randomUUID();
    await asAdmin('ticket.create', { id, siteId: site, title: 'fixture', description: '' });
    return id;
  };
  const fixture = async (site: string): Promise<Fixture> => {
    const ticket = await newTicket(site);
    const part = randomUUID();
    await asAdmin('part.add', { id: part, ticketId: ticket, name: 'filter', quantity: 2 });
    return { site, ticket, part };
  };
  const liveIds = async (sites: string[]) =>
    (
      await t.pool.query<{ id: string }>(`SELECT id FROM entities WHERE NOT deleted AND site_id = ANY($1::uuid[])`, [
        sites,
      ])
    ).rows
      .map((r) => r.id)
      .sort();
  const ids = (changes: Change[]) => changes.map((c) => c.id).sort();
  const sitesOf = (changes: Change[]) => [...new Set(changes.map((c) => c.siteId))].sort();

  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
    baseUrl = await listen(t.app);
    await fixture(A);
    await fixture(B);
  });
  afterAll(() => t?.close());

  describe.each(UNAUTHENTICATED)('$name', (caller) => {
    const stale = encodeCursor({ k: 'd', v: 0, fp: 'other' });
    it.each([
      ['/me', () => request('get', '/me', caller)],
      ['pull without a cursor', () => pull(caller)],
      ['pull with a delta cursor', () => pull(caller, encodeCursor({ k: 'd', v: 1, fp: 'any' }))],
      ['pull that would be a snapshot', () => pull(caller, stale)],
    ])('gets 401 from %s', async (_path, send) => {
      const res = await send();
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('gets 401 from the stream', async () => {
      const stream = await openStream(baseUrl, { token: caller.token });
      stream.req.destroy();
      expect(stream.status).toBe(401);
    });

    it.each(NAMES)('gets 401 from a push of %s', async (name) => {
      const f: Fixture = { site: A, ticket: randomUUID(), part: randomUUID() };
      const res = await request('post', '/sync/push', caller).send({
        clientId: `matrix-${caller.name}`,
        mutations: [{ id: 1, name, args: MUTATORS[name](f, AUTHENTICATED[0]).args }],
      });
      expect(res.status).toBe(401);
    });
  });

  describe.each(AUTHENTICATED)('$name reads', (caller) => {
    it('/me lists exactly its sites', async () => {
      const res = await request('get', '/me', caller);
      expect(res.status).toBe(200);
      expect(res.body.sites.map((s: { id: string }) => s.id).sort()).toEqual([...caller.sites].sort());
    });

    it('pull without a cursor returns its sites only', async () => {
      const res = await pull(caller);
      expect(res.status).toBe(200);
      expect(sitesOf(res.body.changes)).toEqual([...caller.sites].sort());
    });

    it('pull with a delta cursor returns new rows of its sites only', async () => {
      const { cursor } = (await pull(caller)).body;
      const created = { [A]: await newTicket(A), [B]: await newTicket(B) };
      const res = await pull(caller, cursor);
      expect(res.body.mode).toBe('delta');
      expect(ids(res.body.changes)).toEqual(caller.sites.map((s) => created[s]).sort());
    });

    it('pull with a cursor issued for other sites is a snapshot of its sites only', async () => {
      const res = await pull(caller, encodeCursor({ k: 'd', v: 0, fp: 'issued-for-other-sites' }));
      expect(res.body).toMatchObject({ mode: 'snapshot', reason: 'access_changed' });
      expect(ids(res.body.changes)).toEqual(await liveIds(caller.sites));
    });

    it('stream is poked for changes in its sites only', async () => {
      const stream = await openStream(baseUrl, { token: caller.token });
      try {
        expect(stream.status).toBe(200);
        const pokes = () => stream.received().split('event: poke').length - 1;
        const foreign = [A, B].find((s) => !caller.sites.includes(s));
        if (foreign) await newTicket(foreign);
        await newTicket(caller.sites[0]);
        await until(async () => pokes() >= 1, 'a poke for its own site');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(pokes()).toBe(1);
      } finally {
        stream.req.destroy();
      }
    });
  });

  const writes = AUTHENTICATED.flatMap((caller) =>
    NAMES.flatMap((name) =>
      [A, B].map((site) => {
        const own = caller.sites.includes(site);
        return { caller, name, site, own, where: `${own ? 'own' : 'foreign'} site ${site === A ? 'A' : 'B'}` };
      }),
    ),
  );

  it.each(writes)('$caller.name: $name on a ticket of $where', async ({ caller, name, site, own }) => {
    const f = await fixture(site);
    const { args, creates } = MUTATORS[name](f, caller);
    const touched = [f.ticket, f.part, ...(creates ? [creates] : [])];
    const state = async () => ({
      rows: (
        await t.pool.query(
          `SELECT entity, id, site_id, data, deleted, version FROM entities WHERE id = ANY($1::uuid[]) ORDER BY id`,
          [touched],
        )
      ).rows,
      lastVersion: (await t.pool.query(`SELECT last_version FROM sync_state`)).rows[0].last_version,
    });
    const before = await state();

    const res = await request('post', '/sync/push', caller).send({
      clientId: `matrix-${caller.name}-${randomUUID()}`,
      mutations: [{ id: 1, name, args }],
    });

    expect(res.status).toBe(201);
    if (own) {
      expect(res.body.results[0]).toMatchObject({ status: 'applied' });
    } else {
      expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'NO_ACCESS' });
      expect(await state()).toEqual(before);
    }
  });
});
