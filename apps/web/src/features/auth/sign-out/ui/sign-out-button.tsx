'use client';

import { Slot } from '@radix-ui/react-slot';
import type { ReactElement } from 'react';
import { signOut } from '@/entities/session';
import { useSyncStatus } from '@/shared/api';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/shared/ui/alert-dialog';
import { Button } from '@/shared/ui/button';

/** `trigger` replaces the default button, e.g. with a status badge that starts the same sign-out flow. */
export function SignOutButton({ trigger }: { trigger?: ReactElement }) {
  const pending = useSyncStatus().facts.pendingCount;
  const element = trigger ?? (
    <Button variant="outline" size="sm">
      Sign out
    </Button>
  );
  if (pending === 0) return <Slot onClick={signOut}>{element}</Slot>;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{element}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out?</AlertDialogTitle>
          <AlertDialogDescription>
            {pending === 1 ? '1 change is' : `${pending} changes are`} not synced and will stay on this device until you
            sign in again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Stay signed in</AlertDialogCancel>
          <AlertDialogAction onClick={signOut}>Sign out</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
