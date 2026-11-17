import { MemoryStorage, SyncClient, type SyncClientOptions } from '../../src';
import { ScriptedTransport, emptyPull, flush } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';

/**
 * F22: retries use a fixed 5 s delay with no backoff or jitter (every client hammers a recovering server in
 * lockstep), and a push answered with 200 but no results makes the client re-push immediately, forever.
 */
describe('F22 retry scheduling', () => {
  afterEach(() => jest.useRealTimers());

  // `random` is the jitter source the client gains in P3.3; a fixed value makes the delays deterministic.
  const makeClient = (transport: ScriptedTransport) =>
    new SyncClient({
      clientId: 'c1',
      transport,
      storage: new MemoryStorage(),
      random: () => 0.5,
    } as SyncClientOptions);

  it.failing('backs off with growing, capped delays while the server is unreachable', async () => {
    jest.useFakeTimers({ now: 0 });
    const transport = new ScriptedTransport();
    const client = makeClient(transport);
    try {
      client.mutate('ticket.create', { siteId: SITE, title: 'Offline', description: '' });
      await flush();
      for (let step = 0; step < 50 && transport.calls.length < 10; step++) {
        jest.advanceTimersToNextTimer();
        await flush();
      }
      expect(transport.calls.length).toBeGreaterThanOrEqual(10);

      const times = transport.calls.map((c) => c.at);
      const delays = times.slice(1).map((t, i) => t - times[i]);
      expect(new Set(delays).size).toBeGreaterThan(1);
      for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
    } finally {
      client.dispose();
    }
  });

  it.failing('does not spin when a push is answered without results', async () => {
    jest.useFakeTimers();
    const transport = new ScriptedTransport()
      .alwaysPush({ results: [], lastMutationId: 0 })
      .alwaysPull(emptyPull());
    const client = makeClient(transport);
    try {
      client.mutate('ticket.create', { siteId: SITE, title: 'Ignored by the server', description: '' });
      await flush(200);

      expect(transport.callsOf('push').length).toBeLessThanOrEqual(2);
    } finally {
      client.dispose();
    }
  });
});
