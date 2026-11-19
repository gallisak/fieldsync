'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '@/entities/session';
import { FullPageSkeleton } from './full-page-skeleton';

const SIGN_IN = '/sign-in';

// Resolved the way the browser will resolve it, so tabs or backslashes cannot point it at another origin.
function localTarget(next: string | null): string {
  if (!next?.startsWith('/')) return '/';
  try {
    const url = new URL(next, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname === SIGN_IN) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();

  const onSignIn = pathname === SIGN_IN;
  const redirect = session === null && !onSignIn ? 'sign-in' : session && onSignIn ? 'back' : null;

  useEffect(() => {
    // Read here, not with useSearchParams, which would opt the whole layout out of static rendering.
    if (redirect === 'sign-in') {
      const here = `${window.location.pathname}${window.location.search}`;
      router.replace(here === '/' ? SIGN_IN : `${SIGN_IN}?next=${encodeURIComponent(here)}`);
    } else if (redirect === 'back') {
      router.replace(localTarget(new URLSearchParams(window.location.search).get('next')));
    }
  }, [redirect, router]);

  if (session === undefined || redirect) return <FullPageSkeleton />;
  return children;
}
