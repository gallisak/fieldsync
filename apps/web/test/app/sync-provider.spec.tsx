/** @jest-environment jsdom */
import type { SyncClient } from '@fieldsync/sync-core';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SyncProvider } from '@/app/providers/sync-provider';
import { signIn, signOut } from '@/entities/session';

// jest.mock is hoisted above the imports; the factory reads this array only when a client is created.
const created: { userId: string; client: FakeClient }[] = [];

interface FakeClient {
  ready: Promise<void>;
  facts: SyncClient['facts'];
  siteFingerprint: null;
  start: jest.Mock;
  dispose: jest.Mock;
  subscribe: jest.Mock;
}

jest.mock('@/shared/api', () => {
  const actual = jest.requireActual('@/shared/api');
  return {
    ...actual,
    fetchMe: () => new Promise(() => undefined),
    createSyncClient: ({ userId }: { userId: string }) => {
      const client: FakeClient = {
        ready: Promise.resolve(),
        facts: { connection: 'online', phase: 'idle', pendingCount: 0, unresolvedRejections: 0, blocked: null, storage: 'durable' },
        siteFingerprint: null,
        start: jest.fn(),
        dispose: jest.fn(),
        subscribe: jest.fn(() => () => undefined),
      };
      created.push({ userId, client });
      return client;
    },
  };
});

const session = (userId: string) => ({ token: `${userId}-token`, userId, role: 'technician' as const, sites: [] });

describe('SyncProvider', () => {
  let root: Root;
  let container: HTMLElement;
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    created.length = 0;
    localStorage.clear();
    container = document.createElement('div');
    root = createRoot(container);
  });

  const render = async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <SyncProvider>
            <p>app</p>
          </SyncProvider>
        </StrictMode>,
      );
    });
  };
  const live = () => created.filter((c) => c.client.dispose.mock.calls.length === 0);

  it('keeps exactly one started client, disposing the one StrictMode throws away', async () => {
    signIn(session('u1'));
    await render();
    expect(container.textContent).toBe('app');
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(live()).toHaveLength(1);
    expect(live()[0].client.start).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('disposes the client on sign-out and on unmount', async () => {
    signIn(session('u1'));
    await render();
    await act(async () => signOut());
    expect(live()).toHaveLength(0);

    await act(async () => signIn(session('u1')));
    expect(live()).toHaveLength(1);
    await act(async () => root.unmount());
    expect(live()).toHaveLength(0);
  });

  it('replaces the client when another user signs in', async () => {
    signIn(session('u1'));
    await render();
    await act(async () => signIn(session('u2')));
    expect(live().map((c) => c.userId)).toEqual(['u2']);
    await act(async () => root.unmount());
  });
});
