'use client';

import { MutationRejected, type MutatorName } from '@fieldsync/sync-core';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { useSyncClient } from './sync-context';

/**
 * `null` when the change is refused on the spot; otherwise a promise of whether it reached this device's storage.
 * Wait for it before leaving the page: offline, a navigation reloads the document and can cut the write short.
 */
export function useMutate(): (name: MutatorName, args: Record<string, unknown>) => Promise<boolean> | null {
  const client = useSyncClient();
  return useCallback(
    (name, args) => {
      try {
        return client.mutate(name, args).then(
          () => true,
          (err: unknown) => {
            console.error('fieldsync: a change could not be stored on this device', err);
            toast.error('This change could not be saved on this device.');
            return false;
          },
        );
      } catch (err) {
        if (!(err instanceof MutationRejected)) throw err;
        toast.error(err.message);
        return null;
      }
    },
    [client],
  );
}
