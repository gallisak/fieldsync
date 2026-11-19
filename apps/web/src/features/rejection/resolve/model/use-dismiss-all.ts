'use client';

import { toast } from 'sonner';
import { useSyncClient } from '@/shared/api';

export function useDismissAll() {
  const client = useSyncClient();
  return async () => {
    try {
      await client.dismissRejections(client.rejections.map((r) => r.id));
    } catch (err) {
      console.error('fieldsync: could not dismiss the rejections', err);
      toast.error('Could not dismiss every message. Try again.');
    }
  };
}
