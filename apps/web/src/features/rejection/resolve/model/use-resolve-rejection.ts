'use client';

import type { StoredRejection } from '@fieldsync/sync-core';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useMutate, useSyncClient, useSyncSelector } from '@/shared/api';
import { buildRetry } from './build-retry';

export function useResolveRejection(rejection: StoredRejection) {
  const client = useSyncClient();
  const mutate = useMutate();
  const retry = useSyncSelector(useCallback((view) => buildRetry(rejection, view), [rejection]));
  // The rejection disappears only once the dismissal is stored; a second click before that would queue it twice.
  const [retrying, setRetrying] = useState(false);

  const dismiss = () => {
    client.dismissRejection(rejection.id).catch((err: unknown) => {
      console.error('fieldsync: could not dismiss a rejection', err);
      toast.error('Could not dismiss this message. Try again.');
    });
  };
  const tryAgain = retry
    ? () => {
        if (retrying) return;
        setRetrying(true);
        if (mutate(retry.name, retry.args)) dismiss();
        else setRetrying(false);
      }
    : null;

  return { dismiss, tryAgain, retrying };
}
