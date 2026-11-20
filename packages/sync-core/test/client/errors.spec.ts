import { randomUUID } from 'crypto';
import { MemoryStorage, SyncClient, TransportError, type Cursor, type PushResponse } from '../../src';
import { ScriptedTransport, deferred, emptyPull, flush } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';
const create = () => ({ id: randomUUID(), siteId: SITE, title: 'A', description: '' });

describe('client error handling', () => {
  const clients: SyncClient[] = [];
  const open = (transport: ScriptedTransport, storage = new MemoryStorage()) => {
    const c = new SyncClient({ transport, storage, env: {}, random: () => 0.5 });
    clients.push(c);
    return c;
  };
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => {
    for (const c of clients.splice(0)) c.dispose();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('tells a server that answers with errors apart from being offline', async () => {
    const client = open(new ScriptedTransport().alwaysPush(new TransportError('http', 503, 'UNAVAILABLE')));
    await client.ready;
    await client.mutate('ticket.create', create());
    await flush();

    expect(client.facts).toMatchObject({ connection: 'unavailable', blocked: null });
  });

  it('retries a 4xx without an error code, which comes from a proxy, instead of stopping', async () => {
    jest.useFakeTimers();
    const transport = new ScriptedTransport()
      .replyPush(new TransportError('http', 403))
      .alwaysPush({ results: [{ id: 1, status: 'applied' }], lastMutationId: 1 })
      .alwaysPull(emptyPull(1));
    const client = open(transport);
    await client.ready;
    await client.mutate('ticket.create', create());
    await flush();
    expect(client.facts.blocked).toBeNull();

    jest.advanceTimersToNextTimer();
    await flush(50);
    expect(client.pendingCount).toBe(0);
  });

  it('drops a stored cursor the server cannot read and starts over from a snapshot', async () => {
    const storage = new MemoryStorage();
    await storage.load();
    await storage.commitPull({ expectedCursor: null, cursor: 'garbage' as Cursor, lastMutationId: 0, rejections: [] });
    const transport = new ScriptedTransport()
      .replyPull(new TransportError('http', 400, 'BAD_REQUEST'))
      .replyPull({ ...emptyPull(), mode: 'snapshot', reason: 'initial' })
      .alwaysPull(emptyPull());
    const client = open(transport, storage);
    await client.ready;

    await client.sync();

    const cursors = transport.callsOf('pull').map((c) => (c.args[0] as { cursor: Cursor | null }).cursor);
    expect(cursors.slice(0, 2)).toEqual(['garbage', null]);
    expect(client.facts.blocked).toBeNull();
    expect((await storage.load()).cursor).toBe('test-cursor');
  });

  it('waits out the backoff instead of retrying on every new change', async () => {
    jest.useFakeTimers();
    const transport = new ScriptedTransport().alwaysPush(new TransportError('network'));
    const client = open(transport);
    await client.ready;
    await client.mutate('ticket.create', create());
    await flush();
    expect(transport.callsOf('push')).toHaveLength(1);

    for (let i = 0; i < 5; i++) await client.mutate('ticket.create', create());
    await flush();
    expect(transport.callsOf('push')).toHaveLength(1);

    jest.advanceTimersToNextTimer();
    await flush();
    expect(transport.callsOf('push')).toHaveLength(2);
  });

  it('waits out the backoff also for a change made while the failing push was in flight', async () => {
    jest.useFakeTimers();
    const held = deferred<PushResponse>();
    const transport = new ScriptedTransport().replyPush(held.promise).alwaysPush(new TransportError('network'));
    const client = open(transport);
    await client.ready;
    await client.mutate('ticket.create', create());
    await flush();
    await client.mutate('ticket.create', create());
    held.reject(new TransportError('network'));
    await flush(50);
    expect(transport.callsOf('push')).toHaveLength(1);

    jest.advanceTimersToNextTimer();
    await flush();
    expect(transport.callsOf('push')).toHaveLength(2);
  });

  it('stops with an error instead of reporting offline when the device cannot store a pull', async () => {
    class FullStorage extends MemoryStorage {
      override commitPull(): Promise<boolean> {
        return Promise.reject(new DOMException('quota', 'QuotaExceededError'));
      }
    }
    const transport = new ScriptedTransport().alwaysPull(emptyPull());
    const client = open(transport, new FullStorage());
    await client.ready;

    await client.sync();

    expect(client.facts).toMatchObject({ connection: 'online', blocked: 'error' });
    await client.sync();
    expect(transport.callsOf('pull')).toHaveLength(1);
  });

  it('also stops with an error when the device cannot read back what a pull stored', async () => {
    class Unreadable extends MemoryStorage {
      broken = false;
      override load() {
        return this.broken ? Promise.reject(new DOMException('gone', 'UnknownError')) : super.load();
      }
      override loadQueue() {
        return this.broken ? Promise.reject(new DOMException('gone', 'UnknownError')) : super.loadQueue();
      }
    }
    const storage = new Unreadable();
    const client = open(new ScriptedTransport().alwaysPull(emptyPull()), storage);
    await client.ready;
    storage.broken = true;

    await client.sync();

    expect(client.facts).toMatchObject({ connection: 'online', blocked: 'error' });
  });
});
