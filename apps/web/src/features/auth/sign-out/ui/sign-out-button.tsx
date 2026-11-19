'use client';

import { Slot } from '@radix-ui/react-slot';
import type { ReactElement } from 'react';
import { signOut, useViewer } from '@/entities/session';
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
import { Button, buttonVariants } from '@/shared/ui/button';
import { signOutAndClear } from '../model/sign-out-and-clear';

export function SignOutButton({ trigger }: { trigger?: ReactElement }) {
  const { id } = useViewer();
  const pending = useSyncStatus().facts.pendingCount;
  const element = trigger ?? (
    <Button variant="outline" size="sm">
      Sign out
    </Button>
  );
  if (pending === 0) return <Slot onClick={() => signOutAndClear(id)}>{element}</Slot>;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{element}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out?</AlertDialogTitle>
          <AlertDialogDescription>
            {pending === 1 ? '1 change is' : `${pending} changes are`} not synced. Keep them on this device until you sign
            in again, or discard them together with the data stored here.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Stay signed in</AlertDialogCancel>
          <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => signOutAndClear(id)}>
            Discard and sign out
          </AlertDialogAction>
          <AlertDialogAction onClick={signOut}>Keep and sign out</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
