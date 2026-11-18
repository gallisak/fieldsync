import type { SyncBadge, SyncFacts } from '@fieldsync/sync-core';

export interface BadgeDisplay {
  text: string;
  className: string;
  tooltip?: string;
}

const RED = 'border-transparent bg-destructive text-destructive-foreground';

export function badgeDisplay(badge: SyncBadge, facts: SyncFacts): BadgeDisplay {
  switch (badge) {
    case 'synced':
      return { text: 'All changes saved', className: 'border-green-600 bg-transparent text-green-700' };
    case 'pending':
      return {
        text: `${facts.pendingCount} waiting to sync`,
        className: 'border-transparent bg-amber-500 text-white',
        tooltip: 'Will be sent automatically.',
      };
    case 'syncing':
      return { text: 'Syncing…', className: 'border-transparent bg-blue-600 text-white' };
    case 'offline':
      return {
        text: `Offline · ${facts.pendingCount} saved on this device`,
        className: 'border-transparent bg-slate-200 text-slate-800',
        tooltip: 'Changes are kept and sent when the connection returns.',
      };
    case 'rejected':
      return {
        text:
          facts.unresolvedRejections === 1
            ? '1 change was rejected'
            : `${facts.unresolvedRejections} changes were rejected`,
        className: RED,
      };
    case 'auth':
      return { text: 'Sign in again', className: RED, tooltip: 'Your unsynced changes are kept.' };
    case 'upgrade':
      return { text: 'Update required', className: RED };
    case 'error':
      return { text: 'Sync stopped', className: RED, tooltip: 'Reload the page. Unsynced changes are kept.' };
  }
}
