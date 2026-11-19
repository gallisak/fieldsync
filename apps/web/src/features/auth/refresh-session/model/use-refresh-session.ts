'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { updateAccess, useSession } from '@/entities/session';
import { fetchMe, useSyncClient } from '@/shared/api';

export function useRefreshSession(): void {
  const client = useSyncClient();
  const token = useSession()?.token;
  const subscribe = useCallback((cb: () => void) => client.subscribe(cb), [client]);
  const getFingerprint = () => client.siteFingerprint;
  const fingerprint = useSyncExternalStore(subscribe, getFingerprint, getFingerprint);

  useEffect(() => {
    if (!token) return;
    let live = true;
    const refresh = () =>
      void fetchMe(token).then(
        (me) => {
          if (live) updateAccess(token, me);
        },
        () => undefined,
      );
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token, fingerprint]);
}
