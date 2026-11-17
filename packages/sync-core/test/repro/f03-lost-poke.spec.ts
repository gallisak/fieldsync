import { MemoryStorage, SyncClient, type PullResponse } from '../../src';
import { ScriptedTransport, deferred, emptyPull, flush } from '../support/scripted-transport';

/**
 * F3: a poke that arrives while a sync is in flight joins the running sync and is then forgotten; nothing
 * re-runs afterwards unless local mutations are pending, so the server change behind the poke is missed.
 */
describe('F3 poke during an in-flight sync', () => {
  it.failing('pulls again after the running sync finishes', async () => {
    const held = deferred<PullResponse>();
    const transport = new ScriptedTransport().replyPull(held.promise).alwaysPull(emptyPull());
    const client = new SyncClient({ clientId: 'c1', transport, storage: new MemoryStorage() });
    try {
      const first = client.sync();
      await flush();
      expect(transport.callsOf('pull')).toHaveLength(1);

      void client.sync(); // the poke
      held.resolve(emptyPull());
      await first;
      await flush();

      expect(transport.callsOf('pull')).toHaveLength(2);
    } finally {
      client.dispose();
    }
  });
});
