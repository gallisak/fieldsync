import { StreamService } from '../../src/stream.service';
import { TOKENS, listen, openStream, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

describeDb('F20 stream subscribers are released', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it.failing('forgets a subscriber once its connection is gone', async () => {
    const baseUrl = await listen(t.app);
    const streams = await Promise.all(Array.from({ length: 50 }, () => openStream(baseUrl, { token: TOKENS.admin })));
    expect(streams.every((s) => s.status === 200)).toBe(true);
    const service = t.app.get(StreamService);
    expect(service.count).toBe(50);

    for (const s of streams) s.req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(service.count).toBe(0);
  });
});
