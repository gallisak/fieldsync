'use client';

import type { ReactElement, ReactNode } from 'react';
import { SignOutButton } from '@/features/auth/sign-out';
import { useSyncStatus } from '@/shared/api';
import { cn } from '@/shared/lib/utils';
import { badgeVariants } from '@/shared/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/shared/ui/tooltip';
import { badgeDisplay } from '../model/badge-display';

export function SyncStatusBadge({ inbox }: { inbox: (trigger: ReactElement) => ReactNode }) {
  const { badge, facts } = useSyncStatus();
  const { text, className, tooltip } = badgeDisplay(badge, facts);
  const classes = cn(badgeVariants(), className);
  const asButton = (
    <button type="button" className={classes}>
      {text}
    </button>
  );

  const element =
    badge === 'rejected' ? (
      inbox(asButton)
    ) : badge === 'auth' ? (
      <SignOutButton trigger={asButton} />
    ) : (
      <span role="status" className={classes}>
        {text}
      </span>
    );

  if (!tooltip) return element;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{element}</span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
