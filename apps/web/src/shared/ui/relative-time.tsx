'use client';

import { useSyncExternalStore } from 'react';
import { formatRelative } from '@/shared/lib/relative-time';

const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

// One clock for every timestamp on the page, so a long table re-renders once per tick rather than once per row.
const currentTick = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;

function schedule(): void {
  timer = setTimeout(() => {
    schedule();
    for (const listener of listeners) listener();
  }, TICK_MS - (Date.now() % TICK_MS));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearTimeout(timer);
    timer = undefined;
  };
}

/** Re-renders every half minute, so "just now" becomes "1 minute ago" without anything else changing. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const now = useSyncExternalStore(subscribe, currentTick, currentTick);
  return (
    <time dateTime={iso} className={className}>
      {formatRelative(iso, now)}
    </time>
  );
}
