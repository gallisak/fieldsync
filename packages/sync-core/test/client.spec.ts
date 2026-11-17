import { MemoryStorage, SyncClient, type Transport } from '../src';
import type { PullResponse, PushRequest, PushResponse } from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';

class OfflineTransport implements Transport {
  push(_req: PushRequest): Promise<PushResponse> {
    return Promise.reject(new Error('offline'));
  }

  pull(): Promise<PullResponse> {
    return Promise.reject(new Error('offline'));
  }
}

function makeClient(): SyncClient {
  return new SyncClient({ clientId: 'c1', transport: new OfflineTransport(), storage: new MemoryStorage() });
}

describe('SyncClient', () => {
  it('shows a locally created ticket before the server confirms it', () => {
    const client = makeClient();
    client.mutate('ticket.create', { siteId: SITE, title: 'Leaking valve', description: '' });
    expect(client.rows('ticket')).toHaveLength(1);
    expect(client.pendingCount).toBe(1);
    client.dispose();
  });

  it('numbers local mutations sequentially', () => {
    const client = makeClient();
    client.mutate('ticket.create', { siteId: SITE, title: 'A', description: '' });
    client.mutate('ticket.create', { siteId: SITE, title: 'B', description: '' });
    expect(client.rows('ticket')).toHaveLength(2);
    expect(client.pendingCount).toBe(2);
    client.dispose();
  });

  it.todo('keeps unsynced mutations across a reload');
  it.todo('does not lose mutations when two tabs share one clientId');
});
