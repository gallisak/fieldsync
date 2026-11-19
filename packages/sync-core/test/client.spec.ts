import { randomUUID } from 'crypto';
import { MemoryStorage, SyncClient, type Transport } from '../src';
import type { PullResponse, PushRequest, PushResponse } from '../src';
import { encodeCursor } from '../src/protocol/cursor';
import { ScriptedTransport } from './support/scripted-transport';

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
  return new SyncClient({ transport: new OfflineTransport(), storage: new MemoryStorage() });
}

describe('SyncClient', () => {
  it('shows a locally created ticket before the server confirms it', () => {
    const client = makeClient();
    client.mutate('ticket.create', { id: randomUUID(), siteId: SITE, title: 'Leaking valve', description: '' });
    expect(client.rows('ticket')).toHaveLength(1);
    expect(client.pendingCount).toBe(1);
    client.dispose();
  });

  it('numbers local mutations sequentially', async () => {
    const client = makeClient();
    await client.mutate('ticket.create', { id: randomUUID(), siteId: SITE, title: 'A', description: '' });
    await client.mutate('ticket.create', { id: randomUUID(), siteId: SITE, title: 'B', description: '' });
    expect(client.pending.map((m) => m.id)).toEqual([1, 2]);
    client.dispose();
  });

  it('exposes the site fingerprint of the last committed pull', async () => {
    const page = (mode: 'snapshot' | 'delta', fp: string): PullResponse => ({
      mode,
      ...(mode === 'snapshot' ? { reason: 'access_changed' as const } : {}),
      changes: [],
      cursor: encodeCursor({ k: 'd', v: 1, fp }),
      hasMore: false,
      lastMutationId: 0,
      rejections: [],
    });
    const transport = new ScriptedTransport().replyPull(
      page('snapshot', 'a'),
      page('delta', 'a'),
      page('snapshot', 'b'),
      page('delta', 'b'),
    );
    const client = new SyncClient({ transport, storage: new MemoryStorage() });
    await client.ready;
    expect(client.siteFingerprint).toBeNull();

    await client.sync();
    expect(client.siteFingerprint).toBe('a');
    await client.sync();
    expect(client.siteFingerprint).toBe('b');
    client.dispose();
  });

  it('withdraws a change the device could not store', async () => {
    const storage = new MemoryStorage();
    storage.enqueue = () => Promise.reject(new DOMException('quota', 'QuotaExceededError'));
    const client = new SyncClient({ transport: new OfflineTransport(), storage });
    const seen: number[] = [];
    client.subscribe(() => seen.push(client.rows('ticket').length));

    await expect(
      client.mutate('ticket.create', { id: randomUUID(), siteId: SITE, title: 'A', description: '' }),
    ).rejects.toThrow('quota');

    expect(seen).toContain(1);
    expect(client.rows('ticket')).toHaveLength(0);
    expect(client.pendingCount).toBe(0);
    expect(client.facts.pendingCount).toBe(0);
    client.dispose();
  });
});
