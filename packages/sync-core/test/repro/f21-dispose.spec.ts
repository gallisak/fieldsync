import { MemoryStorage, SyncClient } from '../../src';
import { ScriptedTransport, flush } from '../support/scripted-transport';

describe('F21 dispose', () => {
  afterEach(() => jest.useRealTimers());

  it('aborts the request in flight and leaves no timers', async () => {
    jest.useFakeTimers();
    const transport = new ScriptedTransport().replyPull(new Promise(() => undefined));
    const client = new SyncClient({ clientId: 'c1', transport, storage: new MemoryStorage() });
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
});
