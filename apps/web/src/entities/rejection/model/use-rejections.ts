'use client';

import type { StoredRejection } from '@fieldsync/sync-core';
import { useCallback } from 'react';
import { useSyncClient, useSyncSelector, useSyncStatus } from '@/shared/api';
import { newestFirst } from './selectors';

export function useRejections(): StoredRejection[] {
  const client = useSyncClient();
  return useSyncSelector(useCallback(() => newestFirst(client.rejections), [client]));
}

export function useRejectionCount(): number {
  return useSyncStatus().facts.unresolvedRejections;
}
