import { MemoryStorage, SyncClient } from '../../src';
import { ScriptedTransport } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '11111111-1111-4111-8111-111111111111';

/**
 * F17: `ticket.create` draws its id from `crypto.randomUUID()` and its timestamps from `new Date()` inside the
 * mutator. The client replays the queue on every `view()`, so each render sees a different ticket, and the
 * server creates yet another one.
 */
describe('F17 deterministic mutators', () => {
  afterEach(() => jest.useRealTimers());

  it.failing('produces the same ticket on every replay of the queue', () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T10:00:00Z') });
    const client = new SyncClient({ clientId: 'c1', transport: new ScriptedTransport(), storage: new MemoryStorage() });
    try {
      client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'Leaking valve', description: '' });
      const first = [...client.view().values()];
      jest.setSystemTime(new Date('2026-01-01T10:05:00Z'));
      const second = [...client.view().values()];

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(first[0].id).toBe(TICKET);
      expect(second[0].id).toBe(TICKET);
      expect(second[0].createdAt).toBe(first[0].createdAt);
    } finally {
      client.dispose();
    }
  });
});
