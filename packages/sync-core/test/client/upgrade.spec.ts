import { HttpTransport, MemoryStorage, PROTOCOL, PROTOCOL_HEADER, SyncClient, type SyncClock } from '../../src';
import { FakeServer } from '../support/fake-server';
import { flush } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';
const ticket = (n: number) => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
  siteId: SITE,
  title: `t${n}`,
  description: '',
});

function fakeApi(server: FakeServer) {
  const api = { min: PROTOCOL, calls: 0, streams: [] as { aborted: boolean }[] };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    // A client looping on resolved promises would starve the event loop; hanging turns it into a timeout.
    if (++api.calls > 50) return new Promise(() => undefined);
    const version = Number(new Headers(init.headers).get(PROTOCOL_HEADER));
    if (version < api.min) {
      const details = { min: api.min, current: api.min };
      return new Response(JSON.stringify({ code: 'UPGRADE_REQUIRED', message: 'update', details }), { status: 426 });
    }
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/sync/push') return Response.json(server.push(JSON.parse(String(init.body))));
    if (pathname === '/sync/pull') {
      return Response.json(server.pull(searchParams.get('cursor') as never, String(searchParams.get('clientId'))));
    }
    const stream = { aborted: false };
    api.streams.push(stream);
    const body = new ReadableStream<Uint8Array>({
      start: (c) =>
        init.signal?.addEventListener('abort', () => {
          stream.aborted = true;
          c.error(new DOMException('aborted', 'AbortError'));
        }),
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return Object.assign(api, { fetchImpl });
}

function manualClock(): SyncClock & { pending(): number } {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    now: () => 0,
    setTimeout: (fn) => (timers.set(++next, fn), next),
    clearTimeout: (handle) => void timers.delete(handle as number),
    pending: () => timers.size,
  };
}

function newerVersion(): Pick<typeof import('../../src'), 'SyncClient' | 'HttpTransport'> {
  let core!: typeof import('../../src');
  jest.isolateModules(() => {
    jest.doMock('../../src/protocol/version', () => ({
      ...jest.requireActual('../../src/protocol/version'),
      PROTOCOL: PROTOCOL + 1,
      MIN_PROTOCOL: PROTOCOL + 1,
    }));
    core = require('../../src');
  });
  return core;
}

describe('protocol upgrade', () => {
  it('blocks on 426 with the queue kept and nothing running; a newer client drains the queue', async () => {
    const server = new FakeServer();
    const api = fakeApi(server);
    const storage = new MemoryStorage();
    const clock = manualClock();
    const old = new SyncClient({
      transport: new HttpTransport('http://api', 'token', api.fetchImpl),
      storage,
      clock,
      env: {},
      stream: { url: 'http://api/sync/stream', token: 'token', fetchImpl: api.fetchImpl },
    });
    old.start();
    await old.sync();
    await flush();
    expect(api.streams).toEqual([{ aborted: false }]);

    api.min = PROTOCOL + 1;
    await old.mutate('ticket.create', ticket(1));
    await old.mutate('ticket.create', ticket(2));
    await old.sync();
    await flush();

    expect(old.facts.blocked).toBe('upgrade');
    expect(old.pendingCount).toBe(2);
    expect((await storage.load()).pending.map((m) => m.id)).toEqual([1, 2]);
    expect(api.streams).toEqual([{ aborted: true }]);
    expect(clock.pending()).toBe(0);
    await old.sync();
    expect(server.applied).toEqual([]);
    old.dispose();

    const newer = newerVersion();
    const upgraded = new newer.SyncClient({
      transport: new newer.HttpTransport('http://api', 'token', api.fetchImpl),
      storage,
      env: {},
    });
    await upgraded.ready;
    expect(upgraded.pendingCount).toBe(2);
    await upgraded.sync();

    expect(upgraded.facts.blocked).toBeNull();
    expect(upgraded.pendingCount).toBe(0);
    expect(server.applied).toEqual([`${upgraded.clientId}/1`, `${upgraded.clientId}/2`]);
    upgraded.dispose();
  });
});
