import type { TabCoordinator, TabMessage } from './coordinator';

export class WebLocksCoordinator implements TabCoordinator {
  private channel?: BroadcastChannel;
  private pending?: AbortController;
  private release?: () => void;
  private leading = false;
  private closed = false;
  private onLeaderChange?: (isLeader: boolean) => void;

  constructor(private readonly scope: string) {}

  start(onLeaderChange: (isLeader: boolean) => void, onMessage: (m: TabMessage) => void): void {
    this.onLeaderChange = onLeaderChange;
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`fieldsync:${this.scope}`);
      this.channel.onmessage = (event: MessageEvent<TabMessage>) => onMessage(event.data);
    }
    if (!globalThis.navigator?.locks) {
      onLeaderChange(true);
      return;
    }
    // A page frozen in the back/forward cache would keep holding the lock, and no live page could lead.
    globalThis.addEventListener?.('pagehide', this.onPageHide);
    globalThis.addEventListener?.('pageshow', this.onPageShow);
    this.requestLeadership();
  }

  post(m: TabMessage): void {
    this.channel?.postMessage(m);
  }

  close(): void {
    this.closed = true;
    globalThis.removeEventListener?.('pagehide', this.onPageHide);
    globalThis.removeEventListener?.('pageshow', this.onPageShow);
    this.pending?.abort();
    this.release?.();
    this.channel?.close();
  }

  private requestLeadership(): void {
    const pending = (this.pending = new AbortController());
    globalThis.navigator.locks
      .request(`fieldsync-leader:${this.scope}`, { signal: pending.signal }, () => {
        if (this.closed || pending.signal.aborted) return undefined;
        this.leading = true;
        this.onLeaderChange?.(true);
        // Held until released: aborting the signal only cancels a request that is still waiting.
        return new Promise<void>((resolve) => (this.release = resolve));
      })
      .catch(() => undefined);
  }

  private readonly onPageHide = (): void => {
    this.pending?.abort();
    this.release?.();
    this.release = undefined;
    if (!this.leading) return;
    this.leading = false;
    this.onLeaderChange?.(false);
  };

  private readonly onPageShow = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted && !this.closed) this.requestLeadership();
  };
}
