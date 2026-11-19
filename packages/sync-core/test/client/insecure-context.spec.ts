import { HttpTransport, MemoryStorage, SyncClient, newId } from '../../src';
import { emptyPull } from '../support/scripted-transport';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Plain http on a LAN address: browsers leave crypto.randomUUID out there.
describe('without crypto.randomUUID', () => {
  beforeEach(() => Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true }));
  afterEach(() => delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID);

  it('still makes version 4 ids', () => {
    const ids = new Set(Array.from({ length: 100 }, newId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it('starts a client and sends its requests', async () => {
    const requests: Headers[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      requests.push(new Headers(init.headers));
      return Response.json(emptyPull());
    }) as unknown as typeof fetch;
    const client = new SyncClient({
      transport: new HttpTransport('http://api', 'token', fetchImpl),
      storage: new MemoryStorage(),
      env: {},
    });

    await client.ready;
    await client.sync();

    expect(client.clientId).toMatch(UUID_V4);
    expect(client.facts).toMatchObject({ connection: 'online', blocked: null });
    expect(requests[0].get('x-request-id')).toMatch(UUID_V4);
    client.dispose();
  });
});
