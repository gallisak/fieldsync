'use client';

import { signOut } from '@/entities/session';
import { Button } from '@/shared/ui/button';

export function SignOutButton() {
  return (
    <Button variant="outline" size="sm" onClick={signOut}>
      Sign out
    </Button>
  );
}
