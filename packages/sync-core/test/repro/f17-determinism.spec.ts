import { MemoryStorage, SyncClient } from '../../src';
import { ScriptedTransport } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '11111111-1111-4111-8111-111111111111';

describe('F17 deterministic mutators', () => {
  afterEach(() => jest.useRealTimers());

  // A second client on the same storage replays the stored queue from scratch, five minutes later.
  it('produces the same ticket on every replay of the queue', async () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T10:00:00Z'), doNotFake: ['queueMicrotask', 'nextTick'] });
    const storage = new MemoryStorage();
    const open = () => new SyncClient({ transport: new ScriptedTransport(), storage, env: {} });
    const writer = open();
    try {
      await writer.ready;
      await writer.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'Leaking valve', description: '' });
      const first = [...writer.view().values()];

      jest.setSystemTime(new Date('2026-01-01T10:05:00Z'));
      const replayer = open();
      await replayer.ready;
      const second = [...replayer.view().values()];
      replayer.dispose();

      expect(first).toEqual([expect.objectContaining({ id: TICKET, createdAt: '2026-01-01T10:00:00.000Z' })]);
      expect(second).toEqual(first);
    } finally {
      writer.dispose();
    }
  });
});
