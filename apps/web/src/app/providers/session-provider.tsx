'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '@/entities/session';
import { FullPageSkeleton } from './full-page-skeleton';

const SIGN_IN = '/sign-in';

export function SessionProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();

  const onSignIn = pathname === SIGN_IN;
  const redirect = session === null && !onSignIn ? SIGN_IN : session && onSignIn ? '/' : null;

  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  if (session === undefined || redirect) return <FullPageSkeleton />;
  return children;
}
