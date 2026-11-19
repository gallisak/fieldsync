import { MemoryStorage, SyncClient, type SyncClock } from '../../src';
import { ScriptedTransport, emptyPull } from '../support/scripted-transport';

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('poke stream reconnects', () => {
  it('backs off a stream that ends right after it opened, such as one evicted by a newer stream', async () => {
    let now = 0;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let next = 0;
    const clock: SyncClock = {
      now: () => now,
      setTimeout: (fn, ms) => (timers.set(++next, { fn, ms }), next),
      clearTimeout: (handle) => void timers.delete(handle as number),
    };
    let opens = 0;
    const fetchImpl = (async () => {
      opens += 1;
      return new Response('retry: 3000\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const client = new SyncClient({
      transport: new ScriptedTransport().alwaysPull(emptyPull()),
      storage: new MemoryStorage(),
      clock,
      env: {},
      random: () => 1,
      stream: { url: 'http://api/sync/stream', token: 'token', fetchImpl },
    });
    client.start();

    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      await settle();
      const [handle, reconnect] = [...timers].find(([, t]) => t.ms < 45_000)!;
      timers.delete(handle);
      waits.push(reconnect.ms);
      now += reconnect.ms;
      reconnect.fn();
    }
    await settle();

    expect(opens).toBe(6);
    expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
    client.dispose();
  });
});
