'use client';

import type { Row } from '@fieldsync/sync-core';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useSyncClient } from './sync-context';

type View = ReadonlyMap<string, Row>;

export function useSyncSelector<T>(selector: (view: View) => T): T {
  const client = useSyncClient();
  const cache = useRef<{ version: number; selector: unknown; value: T } | null>(null);

  const subscribe = useCallback((cb: () => void) => client.subscribe(cb), [client]);
  // useSyncExternalStore needs the same object back while nothing changed, or React re-renders forever.
  const getSnapshot = () => {
    const version = client.snapshotVersion;
    let hit = cache.current;
    if (!hit || hit.version !== version || hit.selector !== selector) {
      hit = { version, selector, value: selector(client.view()) };
      cache.current = hit;
    }
    return hit.value;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
