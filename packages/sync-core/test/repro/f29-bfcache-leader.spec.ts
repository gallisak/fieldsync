import { WebLocksCoordinator } from '../../src/tabs/web-locks';

class FakeLocks {
  private held = false;
  private readonly queue: { cb: () => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];

  request(_name: string, opts: { signal?: AbortSignal }, cb: () => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry = { cb, resolve, reject };
      opts.signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error('aborted'));
      });
      this.queue.push(entry);
      this.grant();
    });
  }

  private grant(): void {
    if (this.held) return;
    const next = this.queue.shift();
    if (!next) return;
    this.held = true;
    void Promise.resolve(next.cb()).then((value) => {
      this.held = false;
      next.resolve(value);
      this.grant();
    });
  }
}

const page = new EventTarget();
const pageEvent = (type: 'pagehide' | 'pageshow', persisted: boolean) =>
  Object.defineProperty(new Event(type), 'persisted', { value: persisted });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const opened: WebLocksCoordinator[] = [];
const coordinator = () => {
  const c = new WebLocksCoordinator('user');
  opened.push(c);
  return c;
};
afterEach(() => {
  for (const c of opened.splice(0)) c.close();
});

const saved = {
  navigator: globalThis.navigator,
  add: globalThis.addEventListener,
  remove: globalThis.removeEventListener,
};
beforeAll(() => {
  Object.defineProperty(globalThis, 'navigator', { value: { locks: new FakeLocks() }, configurable: true });
  globalThis.addEventListener = page.addEventListener.bind(page) as typeof globalThis.addEventListener;
  globalThis.removeEventListener = page.removeEventListener.bind(page) as typeof globalThis.removeEventListener;
});
afterAll(() => {
  Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true });
  globalThis.addEventListener = saved.add;
  globalThis.removeEventListener = saved.remove;
});

describe('F29 a page kept in the back/forward cache keeps the leadership', () => {
  it(
    'hands the leadership on when the page is hidden into the cache, and asks again when it is shown',
    async () => {
      const a = coordinator();
      const aLeads: boolean[] = [];
      a.start(
        (leader) => aLeads.push(leader),
        () => undefined,
      );
      await flush();
      expect(aLeads).toEqual([true]);

      page.dispatchEvent(pageEvent('pagehide', true));
      const b = coordinator();
      const bLeads: boolean[] = [];
      b.start(
        (leader) => bLeads.push(leader),
        () => undefined,
      );
      await flush();
      expect(bLeads).toEqual([true]);
      expect(aLeads).toEqual([true, false]);

      page.dispatchEvent(pageEvent('pageshow', true));
      await flush();
      expect(aLeads).toEqual([true, false]);
      b.close();
      await flush();
      expect(aLeads).toEqual([true, false, true]);
    },
  );
});
