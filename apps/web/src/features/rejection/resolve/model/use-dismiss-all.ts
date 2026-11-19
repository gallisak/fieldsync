'use client';

import { toast } from 'sonner';
import { useSyncClient } from '@/shared/api';

export function useDismissAll() {
  const client = useSyncClient();
  return async () => {
    try {
      for (const r of [...client.rejections]) await client.dismissRejection(r.mutation.id);
    } catch (err) {
      console.error('fieldsync: could not dismiss the rejections', err);
      toast.error('Could not dismiss every message. Try again.');
    }
  };
}
