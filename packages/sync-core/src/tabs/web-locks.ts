import type { TabCoordinator, TabMessage } from './coordinator';

/**
 * Browser tabs: leadership through a Web Lock (held for as long as the tab leads; a closed or crashed tab
 * releases it and the next waiting tab gets it), messages through a `BroadcastChannel`. Without Web Locks every
 * tab leads, which is safe, only less efficient.
 */
export class WebLocksCoordinator implements TabCoordinator {
  private readonly abort = new AbortController();
  private channel?: BroadcastChannel;
  private release?: () => void;
  private closed = false;

  constructor(private readonly scope: string) {}

  start(onLeaderChange: (isLeader: boolean) => void, onMessage: (m: TabMessage) => void): void {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`fieldsync:${this.scope}`);
      this.channel.onmessage = (event: MessageEvent<TabMessage>) => onMessage(event.data);
    }
    const locks = globalThis.navigator?.locks;
    if (!locks) {
      onLeaderChange(true);
      return;
    }
    locks
      .request(`fieldsync-leader:${this.scope}`, { signal: this.abort.signal }, () => {
        if (this.closed) return undefined;
        onLeaderChange(true);
        // Held until close(): aborting the signal only cancels a request that is still waiting.
        return new Promise<void>((resolve) => (this.release = resolve));
      })
      .catch(() => undefined); // the waiting request was cancelled by close()
  }

  post(m: TabMessage): void {
    this.channel?.postMessage(m);
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
    this.release?.();
    this.channel?.close();
  }
}
