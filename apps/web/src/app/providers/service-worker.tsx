'use client';

import { useEffect } from 'react';
import { useSyncStatus } from '@/shared/api';

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
      console.error('fieldsync: the offline shell could not be installed', err);
    });
  }, []);
  return null;
}

export function UpdateShellOnUpgrade() {
  const { badge } = useSyncStatus();
  useEffect(() => {
    if (badge !== 'upgrade' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.update())
      .catch(() => undefined);
  }, [badge]);
  return null;
}
