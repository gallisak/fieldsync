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
          {/* Focusable only around the plain status, so keyboard users reach its tooltip; a button already is. */}
          <span
            className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            tabIndex={badge === 'rejected' || badge === 'auth' ? undefined : 0}
          >
            {element}
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
