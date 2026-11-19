import { MemoryStorage, SyncClient, type SyncClock } from '../../src';
import { ScriptedTransport, emptyPull, flush } from '../support/scripted-transport';

describe('F21 dispose', () => {
  afterEach(() => jest.useRealTimers());

  it('aborts the request in flight and leaves no timers', async () => {
    jest.useFakeTimers();
    const transport = new ScriptedTransport().replyPull(new Promise(() => undefined));
    const client = new SyncClient({ transport, storage: new MemoryStorage() });
    void client.sync();
    await flush();
    expect(transport.callsOf('pull')).toHaveLength(1);

    client.dispose();
    await flush();

    const signal = transport.callsOf('pull')[0].args.find((a): a is AbortSignal => a instanceof AbortSignal);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('after start, also stops the poll, the poke stream and the listeners', async () => {
    const timers = new Set<number>();
    let next = 0;
    const clock: SyncClock = {
      now: () => 0,
      setTimeout: () => (timers.add(++next), next),
      clearTimeout: (handle) => void timers.delete(handle as number),
    };
    const streams: AbortSignal[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const signal = init.signal!;
      streams.push(signal);
      // As fetch does: aborting the request errors its body.
      const body = new ReadableStream<Uint8Array>({
        start: (c) => signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))),
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const listeners = { online: 0, visible: 0 };
    const subscribe = (key: keyof typeof listeners) => () => {
      listeners[key] += 1;
      return () => void (listeners[key] -= 1);
    };
    const client = new SyncClient({
      transport: new ScriptedTransport().alwaysPull(emptyPull()),
      storage: new MemoryStorage(),
      clock,
      env: { onOnline: subscribe('online'), onVisible: subscribe('visible') },
      stream: { url: 'http://api/sync/stream', token: 'token', fetchImpl },
    });
    client.start();
    await client.sync();
    await flush();
    expect(timers.size).toBeGreaterThan(0);
    expect(streams).toHaveLength(1);
    expect(listeners).toEqual({ online: 1, visible: 1 });

    client.dispose();
    await flush();

    expect(timers.size).toBe(0);
    expect(streams[0].aborted).toBe(true);
    expect(listeners).toEqual({ online: 0, visible: 0 });
  });
});
