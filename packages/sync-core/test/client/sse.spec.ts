import { PROTOCOL, PROTOCOL_HEADER, TransportError, openPokeStream } from '../../src';
import { flush } from '../support/scripted-transport';

function fakeStream(status = 200, errorBody?: unknown) {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (body = c) });
  const encoder = new TextEncoder();
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    init.signal?.addEventListener('abort', () => body.error(new DOMException('aborted', 'AbortError')));
    if (status !== 200) return new Response(JSON.stringify(errorBody), { status });
    return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    requests,
    send: (text: string) => body.enqueue(encoder.encode(text)),
    close: () => body.close(),
  };
}

/** The stream's outcome as a value, captured at once so an early failure is never an unhandled rejection. */
const settle = (p: Promise<void>): Promise<'ended' | unknown> => p.then(
  () => 'ended',
  (err: unknown) => err,
);

describe('openPokeStream', () => {
  afterEach(() => jest.useRealTimers());
  const base = { url: 'http://api/sync/stream', token: 'secret' };

  it('calls onPoke once per poke frame, also when frames are split across chunks', async () => {
    const server = fakeStream();
    const onPoke = jest.fn();
    const onOpen = jest.fn();
    const done = settle(openPokeStream({ ...base, fetchImpl: server.fetchImpl, onPoke, onOpen }));
    await flush();
    expect(onOpen).toHaveBeenCalledTimes(1);

    server.send('retry: 3000\n\n');
    server.send('event: po');
    server.send('ke\ndata: {}\n');
    server.send('\nevent: poke\r\ndata: {}\r\n\r\n: hb\n\nevent: other\ndata: {}\n\n');
    await flush();
    expect(onPoke).toHaveBeenCalledTimes(2);

    server.close();
    expect(await done).toBe('ended');

    const [{ url, init }] = server.requests;
    expect(url).toBe('http://api/sync/stream');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer secret',
      accept: 'text/event-stream',
      [PROTOCOL_HEADER]: String(PROTOCOL),
    });
  });

  it('keeps a stream that only sends heartbeats', async () => {
    jest.useFakeTimers();
    const server = fakeStream();
    const onPoke = jest.fn();
    const done = settle(openPokeStream({ ...base, fetchImpl: server.fetchImpl, onPoke, watchdogMs: 1_000 }));
    await flush();
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(600);
      server.send(': hb\n\n');
      await flush();
    }
    expect(server.requests[0].init.signal?.aborted).toBe(false);
    expect(onPoke).not.toHaveBeenCalled();

    server.close();
    expect(await done).toBe('ended');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('resolves when the server ends the stream', async () => {
    const server = fakeStream();
    const done = settle(openPokeStream({ ...base, fetchImpl: server.fetchImpl, onPoke: jest.fn() }));
    await flush();
    server.close();
    expect(await done).toBe('ended');
  });

  it('aborts a silent stream when the watchdog fires', async () => {
    jest.useFakeTimers();
    const server = fakeStream();
    const done = settle(openPokeStream({ ...base, fetchImpl: server.fetchImpl, onPoke: jest.fn(), watchdogMs: 1_000 }));
    await flush();
    server.send('retry: 3000\n\n');
    await flush();

    jest.advanceTimersByTime(1_000);
    const err = await done;
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('timeout');
    expect(server.requests[0].init.signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports a refused stream as an http TransportError with the server code', async () => {
    const server = fakeStream(401, { code: 'UNAUTHENTICATED', message: 'Unauthorized' });
    const err = await settle(openPokeStream({ ...base, fetchImpl: server.fetchImpl, onPoke: jest.fn() }));
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ kind: 'http', status: 401, code: 'UNAUTHENTICATED' });
  });

  it('rejects with the abort reason, not a TransportError, when the caller aborts', async () => {
    const server = fakeStream();
    const caller = new AbortController();
    const done = settle(openPokeStream({ ...base, fetchImpl: server.fetchImpl, onPoke: jest.fn(), signal: caller.signal }));
    await flush();
    caller.abort(new Error('disposed'));
    const err = await done;
    expect(err).not.toBeInstanceOf(TransportError);
    expect(server.requests[0].init.signal?.aborted).toBe(true);
  });
});
