'use client';

import type { ReactNode } from 'react';
import { useSyncStatus } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';

export function UpgradeGate({ children }: { children: ReactNode }) {
  const { badge, facts } = useSyncStatus();
  if (badge !== 'upgrade') return children;

  const n = facts.pendingCount;
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <CardTitle>A new version of FieldSync is required</CardTitle>
          <CardDescription>
            {n === 0
              ? 'Reload to get it.'
              : `Your ${n} unsynced ${n === 1 ? 'change is' : 'changes are'} kept and will be sent after the update.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => location.reload()}>Reload</Button>
        </CardContent>
      </Card>
    </div>
  );
}
