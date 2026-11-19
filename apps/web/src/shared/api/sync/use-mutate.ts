'use client';

import { MutationRejected, type MutatorName } from '@fieldsync/sync-core';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { useSyncClient } from './sync-context';

export function useMutate(): (name: MutatorName, args: Record<string, unknown>) => boolean {
  const client = useSyncClient();
  return useCallback(
    (name, args) => {
      try {
        client.mutate(name, args).catch((err: unknown) => {
          console.error('fieldsync: a change could not be stored on this device', err);
          toast.error('This change could not be saved on this device.');
        });
        return true;
      } catch (err) {
        if (!(err instanceof MutationRejected)) throw err;
        toast.error(err.message);
        return false;
      }
    },
    [client],
  );
}
