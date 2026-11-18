import { PROTOCOL, PROTOCOL_HEADER } from '../protocol/version';
import { TransportError } from '../transport/errors';

/** The server sends a heartbeat comment every 25 s; a stream silent for 2.5 of those is presumed dead. */
export const STREAM_WATCHDOG_MS = 62_500;

export interface PokeStreamOptions {
  url: string;
  token: string;
  onPoke(): void;
  onOpen?(): void;
  onData?(): void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  watchdogMs?: number;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

const globalTimers = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isPoke(frame: string): boolean {
  return frame.split('\n').some((line) => /^event: ?poke$/.test(line));
}

export async function openPokeStream(opts: PokeStreamOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timers = opts.timers ?? globalTimers;
  const watchdogMs = opts.watchdogMs ?? STREAM_WATCHDOG_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  let watchdogFired = false;
  let watchdog: unknown;
  const arm = () => {
    if (watchdog !== undefined) timers.clearTimeout(watchdog);
    watchdog = timers.setTimeout(() => {
      watchdogFired = true;
      controller.abort();
    }, watchdogMs);
  };
  const failure = (err: unknown) => {
    if (watchdogFired) return new TransportError('timeout', undefined, undefined, undefined, 'Stream went silent', { cause: err });
    if (opts.signal?.aborted) return opts.signal.reason ?? err;
    return new TransportError('network', undefined, undefined, undefined, undefined, { cause: err });
  };

  try {
    arm();
    let res: Response;
    try {
      res = await fetchImpl(opts.url, {
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${opts.token}`,
          accept: 'text/event-stream',
          [PROTOCOL_HEADER]: String(PROTOCOL),
        },
      });
    } catch (err) {
      throw failure(err);
    }
    if (res.status !== 200 || !res.body) {
      const body = (await res.json().catch(() => undefined)) as { code?: unknown; message?: unknown } | undefined;
      throw new TransportError(
        'http',
        res.status,
        typeof body?.code === 'string' ? body.code : undefined,
        undefined,
        typeof body?.message === 'string' ? body.message : undefined,
      );
    }
    opts.onOpen?.();

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw failure(err);
      }
      if (chunk.done) return;
      arm();
      opts.onData?.();
      buffer += chunk.value.replace(/\r/g, '');
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (isPoke(frame)) opts.onPoke();
      }
    }
  } finally {
    if (watchdog !== undefined) timers.clearTimeout(watchdog);
    opts.signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}
