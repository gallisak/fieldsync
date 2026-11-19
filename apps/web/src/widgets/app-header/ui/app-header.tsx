'use client';

import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';
import { useRejectionCount } from '@/entities/rejection';
import { useViewer } from '@/entities/session';
import { SignOutButton } from '@/features/auth/sign-out';
import { useSyncStatus } from '@/shared/api';
import { Alert, AlertDescription } from '@/shared/ui/alert';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { SyncStatusBadge } from './sync-status-badge';

interface AppHeaderProps {
  inbox: (trigger: ReactElement) => ReactNode;
}

export function AppHeader({ inbox }: AppHeaderProps) {
  const viewer = useViewer();
  const rejected = useRejectionCount();
  const { facts } = useSyncStatus();
  const role = viewer.role === 'admin' ? 'Admin' : 'Technician';

  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 p-4">
        <Link href="/" className="text-lg font-semibold">
          FieldSync
        </Link>
        <SyncStatusBadge inbox={inbox} />
        <div className="flex items-center gap-2">
          {inbox(
            <Button variant="outline" size="sm">
              Rejected
              {rejected > 0 && <Badge variant="destructive">{rejected}</Badge>}
            </Button>,
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={`Account: ${role}`}>
                {role}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="space-y-1">
                <span className="block">{role}</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {viewer.sites.map((s) => s.name).join(', ') || 'No sites'}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <SignOutButton trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>Sign out</DropdownMenuItem>} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {facts.storage === 'memory' && (
        <div className="mx-auto max-w-5xl px-4 pb-4">
          <Alert variant="destructive">
            <AlertDescription>
              This browser cannot store data. Changes will be lost if you close the tab before they sync.
            </AlertDescription>
          </Alert>
        </div>
      )}
    </header>
  );
}
