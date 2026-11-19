'use client';

import { useEffect, useState } from 'react';
import { formatRelative } from '@/shared/lib/relative-time';

/** Re-renders every half minute, so "just now" becomes "1 minute ago" without anything else changing. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time dateTime={iso} className={className}>
      {formatRelative(iso, now)}
    </time>
  );
}
