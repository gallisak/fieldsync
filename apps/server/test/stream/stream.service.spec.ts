import type { Response } from 'express';
import type { AccessService } from '../../src/access/access.service';
import type { AppConfig } from '../../src/config/env';
import type { Db } from '../../src/database/db.service';
import { StreamService } from '../../src/stream.service';

const POKE = 'event: poke\ndata: {}\n\n';

function fakeResponse() {
  const handlers = new Map<string, () => void>();
  const res = {
    socket: { destroyed: false },
    writableNeedDrain: false,
    written: [] as string[],
    writeHead: () => res,
    write: (chunk: string) => res.written.push(chunk),
    end: () => handlers.get('close')?.(),
    on: (event: string, fn: () => void) => handlers.set(event, fn),
    pokes: () => res.written.filter((w) => w === POKE).length,
  };
  return res;
}

describe('StreamService', () => {
  const granted = new Map<string, string[]>();
  const db = { pool: { query: async (_sql: string, [id]: string[]) => ({ rows: [{ id, role: 'technician' }] }) } };
  const access = { accessibleSites: async (_q: unknown, user: { id: string }) => new Set(granted.get(user.id)) };
  const open = () =>
    new StreamService(db as unknown as Db, access as unknown as AccessService, { STREAM_MAX_PER_USER: 2 } as AppConfig);
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(() => {
    granted.clear();
    granted.set('u1', ['s1']).set('u2', ['s2']);
  });

  it('pokes only the streams that see a changed site, once each', async () => {
    const streams = open();
    const [a, b, c] = [fakeResponse(), fakeResponse(), fakeResponse()];
    streams.add('u1', ['s1'], a as unknown as Response);
    streams.add('u2', ['s2'], b as unknown as Response);
    granted.set('u2', ['s2', 's1']);
    streams.add('u2', ['s2', 's1'], c as unknown as Response);
    await settle();

    streams.notify(['s1', 's2']);
    expect([a.pokes(), b.pokes(), c.pokes()]).toEqual([1, 1, 1]);
    streams.notify(['s1']);
    expect([a.pokes(), b.pokes(), c.pokes()]).toEqual([2, 2, 2]);
  });

  it('follows a refreshed site list and forgets closed or evicted streams', async () => {
    const streams = open();
    const [a, b, c] = [fakeResponse(), fakeResponse(), fakeResponse()];
    streams.add('u1', ['s1'], a as unknown as Response);
    granted.set('u1', ['s2']);
    await streams.refreshUser('u1');
    const afterRefresh = a.pokes();

    streams.notify(['s1']);
    expect(a.pokes()).toBe(afterRefresh);
    streams.notify(['s2']);
    expect(a.pokes()).toBe(afterRefresh + 1);

    streams.add('u1', ['s2'], b as unknown as Response);
    streams.add('u1', ['s2'], c as unknown as Response);
    await settle();
    expect(streams.count).toBe(2);
    b.end();
    expect(streams.count).toBe(1);
    streams.notify(['s2']);
    expect([a.pokes(), b.pokes(), c.pokes()]).toEqual([afterRefresh + 1, 0, 1]);
  });
});
