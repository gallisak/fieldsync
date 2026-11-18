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

  it.failing('forgets a subscriber once its connection is gone', async () => {
    const { baseUrl, service } = await start();
    const streams = await Promise.all(Array.from({ length: 50 }, () => open(baseUrl, TOKENS.admin)));
    expect(streams.every((s) => s.status === 200)).toBe(true);
    expect(service.count).toBe(50);

    for (const s of streams) s.req.destroy();
    await sleep(100);

    expect(service.count).toBe(0);
  });

  it.failing('reports 0 open streams after 500 open/close cycles', async () => {
    const { t, baseUrl, service } = await start();
    for (let batch = 0; batch < 10; batch++) {
      const streams = await Promise.all(Array.from({ length: 50 }, () => open(baseUrl, TOKENS.admin)));
      for (const s of streams) s.req.destroy();
    }
    await until(() => service.count === 0);

    const metrics = (await t.http.get('/metrics')).text;
    expect(metrics).toMatch(/^fieldsync_active_streams 0$/m);
  });

  it.failing('forgets a client that left while its stream was being opened', async () => {
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

  it.failing('coalesces pokes while a client is not reading', async () => {
    const { baseUrl, service } = await start();
    const add = jest.spyOn(service, 'add');
    const stream = await open(baseUrl, TOKENS.admin, false);
    const res = add.mock.calls[0][2] as Response;

    const pokes = 200_000;
    for (let i = 0; i < pokes; i++) service.notify([DEMO.siteA]);
    expect(res.writableLength).toBeLessThan(64 * 1024);

    let body = '';
    stream.res.on('data', (chunk: string) => (body += chunk));
    await until(() => res.writableLength === 0 && body.endsWith(POKE));
    await sleep(50);

    expect(body.endsWith(POKE)).toBe(true);
    expect(body.split(POKE).length - 1).toBeLessThan(pokes);
  });

  it.failing('sends a heartbeat to every open stream', async () => {
    const { baseUrl } = await start({ STREAM_HEARTBEAT_MS: '50' });
    const streams = [await open(baseUrl, TOKENS.admin), await open(baseUrl, TOKENS.techA)];
    await sleep(200);

    for (const s of streams) expect(s.received()).toContain(': hb\n\n');
  });

  it.failing('refuses more than STREAM_MAX_PER_USER streams for one user', async () => {
    const { baseUrl, service } = await start({ STREAM_MAX_PER_USER: '2' });
    const first = await open(baseUrl, TOKENS.admin);
    expect((await open(baseUrl, TOKENS.admin)).status).toBe(200);
    expect((await open(baseUrl, TOKENS.admin)).status).toBe(429);
    expect((await open(baseUrl, TOKENS.techA)).status).toBe(200);

    first.req.destroy();
    await until(() => service.count === 2);
    expect((await open(baseUrl, TOKENS.admin)).status).toBe(200);
  });

  it.failing('ends open streams when the server shuts down', async () => {
    const { t: app, baseUrl } = await start();
    const stream = await open(baseUrl, TOKENS.admin);
    const ended = new Promise((resolve) => stream.res.on('end', () => resolve('ended')));

    t = undefined;
    const closing = app.close();
    try {
      const outcome = await Promise.race([closing.then(() => ended), sleep(2000).then(() => 'hung')]);
      expect(outcome).toBe('ended');
    } finally {
      stream.req.destroy();
      await closing;
    }
  });
});
