'use client';

import type { StoredRejection, TicketStatus } from '@fieldsync/sync-core';
import { Button } from '@/shared/ui/button';
import { useResolveRejection } from '../model/use-resolve-rejection';

const STATUS: Record<TicketStatus, string> = {
  open: 'open',
  in_progress: 'in progress',
  done: 'done',
  cancelled: 'cancelled',
};

export function ResolveRejectionActions({ rejection }: { rejection: StoredRejection }) {
  const { dismiss, tryAgain, retrying } = useResolveRejection(rejection);
  const to = rejection.mutation.args.to as TicketStatus;
  const retryLabel = rejection.code === 'STATUS_CONFLICT' ? `Set to ${STATUS[to] ?? to} anyway` : 'Try again';

  return (
    <div className="flex gap-2">
      {tryAgain && (
        <Button size="sm" onClick={tryAgain} disabled={retrying}>
          {retryLabel}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={dismiss}>
        Dismiss
      </Button>
    </div>
  );
}
