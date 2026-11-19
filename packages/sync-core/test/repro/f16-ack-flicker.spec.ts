import { MemoryStorage, SyncClient, type PullResponse } from '../../src';
import { ScriptedTransport, deferred, flush } from '../support/scripted-transport';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '11111111-1111-4111-8111-111111111111';

describe('F16 acknowledgement before the pull', () => {
  it('keeps showing an acknowledged change until the pull delivers it', async () => {
    const held = deferred<PullResponse>();
    const transport = new ScriptedTransport()
      .replyPush({ results: [{ id: 1, status: 'applied' }], lastMutationId: 1 })
      .replyPull(held.promise);
    const client = new SyncClient({ transport, storage: new MemoryStorage() });
    try {
      await client.ready;
      await client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'Leaking valve', description: '' });
      await flush();
      expect(transport.callsOf('push')).toHaveLength(1);
      expect(transport.callsOf('pull')).toHaveLength(1);

      expect(client.rows('ticket').map((r) => r.title)).toEqual(['Leaking valve']);
    } finally {
      held.reject(new Error('test over'));
      client.dispose();
    }
  });
});
