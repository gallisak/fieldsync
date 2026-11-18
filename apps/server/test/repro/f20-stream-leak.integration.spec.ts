import { request as httpRequest } from 'http';
import type { Response } from 'express';
import { PROTOCOL, PROTOCOL_HEADER } from '@fieldsync/sync-core';
import { AccessService } from '../../src/access/access.service';
import { StreamService } from '../../src/stream.service';
import { DEMO, TOKENS, listen, openStream, seed, type OpenStream } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

const POKE = 'event: poke\ndata: {}\n\n';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(10);
}

describeDb('F20 stream subscribers are released', () => {
  let t: TestApp | undefined;
  let opened: OpenStream[] = [];

  const start = async (env: Record<string, string> = {}) => {
    t = await createTestApp(env);
    await seed(t.pool);
    return { t, baseUrl: await listen(t.app), service: t.app.get(StreamService) };
  };
  const open = async (baseUrl: string, token: string, read = true) => {
    const stream = await openStream(baseUrl, { token, read });
    opened.push(stream);
    return stream;
  };

  afterEach(async () => {
    for (const s of opened) s.req.destroy();
    opened = [];
    await t?.close();
    t = undefined;
  });

  it('forgets a subscriber once its connection is gone', async () => {
    const { baseUrl, service } = await start({ STREAM_MAX_PER_USER: '50' });
    const streams = await Promise.all(Array.from({ length: 50 }, () => open(baseUrl, TOKENS.admin)));
    expect(streams.every((s) => s.status === 200)).toBe(true);
    expect(service.count).toBe(50);

    for (const s of streams) s.req.destroy();
    await sleep(100);

    expect(service.count).toBe(0);
  });

  it('reports 0 open streams after 500 open/close cycles', async () => {
    const { t, baseUrl, service } = await start({ STREAM_MAX_PER_USER: '50' });
    for (let batch = 0; batch < 10; batch++) {
      const streams = await Promise.all(Array.from({ length: 50 }, () => open(baseUrl, TOKENS.admin)));
      expect(streams.every((s) => s.status === 200)).toBe(true);
      for (const s of streams) s.req.destroy();
      await until(() => service.count === 0);
      expect(service.count).toBe(0);
    }

    const metrics = (await t.http.get('/metrics')).text;
    expect(metrics).toMatch(/^fieldsync_active_streams 0$/m);
  });

  it('forgets a client that left while its stream was being opened', async () => {
    const { t, baseUrl, service } = await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const access = t.app.get(AccessService);
    const real = access.accessibleSites.bind(access);
    const called = new Promise<void>((resolve) => {
      jest.spyOn(access, 'accessibleSites').mockImplementationOnce(async (...args) => {
        resolve();
        await gate;
        return real(...args);
      });
    });

    const req = httpRequest(`${baseUrl}/sync/stream`, {
      headers: { [PROTOCOL_HEADER]: String(PROTOCOL), authorization: `Bearer ${TOKENS.admin}` },
    });
    req.on('error', () => undefined);
    req.end();
    await called;
    req.destroy();
    await sleep(50);
    release();
    await sleep(100);

    expect(service.count).toBe(0);
  });

  it('coalesces pokes while a client is not reading, and sends one once it reads again', async () => {
    const { baseUrl, service } = await start();
    const add = jest.spyOn(service, 'add');
    const stream = await open(baseUrl, TOKENS.admin, false);
    const res = add.mock.calls[0][2] as Response;
    const write = jest.spyOn(res, 'write');

    const pokes = 200_000;
    for (let i = 0; i < pokes; i++) service.notify([DEMO.siteA]);
    const written = write.mock.calls.length;
    expect(written).toBeLessThan(pokes);
    expect(res.writableLength).toBeLessThan(res.writableHighWaterMark + POKE.length * 2);

    let body = '';
    const received = () => body.split(POKE).length - 1;
    stream.res.on('data', (chunk: string) => (body += chunk));
    await until(() => received() > written);
    await sleep(50);

    expect(write.mock.calls.length).toBe(written + 1);
    expect(received()).toBe(written + 1);
  });

  it('sends a heartbeat to every open stream', async () => {
    const { baseUrl } = await start({ STREAM_HEARTBEAT_MS: '50' });
    const streams = [await open(baseUrl, TOKENS.admin), await open(baseUrl, TOKENS.techA)];
    await sleep(200);

    for (const s of streams) expect(s.received()).toContain(': hb\n\n');
  });

  it('refuses more than STREAM_MAX_PER_USER streams for one user', async () => {
    const { baseUrl, service } = await start({ STREAM_MAX_PER_USER: '2' });
    const first = await open(baseUrl, TOKENS.admin);
    expect((await open(baseUrl, TOKENS.admin)).status).toBe(200);
    expect((await open(baseUrl, TOKENS.admin)).status).toBe(429);
    expect((await open(baseUrl, TOKENS.techA)).status).toBe(200);

    first.req.destroy();
    await until(() => service.count === 2);
    expect((await open(baseUrl, TOKENS.admin)).status).toBe(200);
  });

  it('ends open streams when the server shuts down', async () => {
    const { t: app, baseUrl } = await start();
    const stream = await open(baseUrl, TOKENS.admin);
    const ended = new Promise((resolve) => stream.res.on('end', () => resolve('ended')));

    t = undefined;
    const closing = app.close();
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise((resolve) => (timer = setTimeout(resolve, 2000, 'hung')));
    try {
      expect(await Promise.race([closing.then(() => ended), hung])).toBe('ended');
    } finally {
      clearTimeout(timer);
      stream.req.destroy();
      await closing;
    }
  });
});
