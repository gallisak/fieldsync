'use client';

import { ALLOWED_TRANSITIONS, type TicketStatus } from '@fieldsync/sync-core';
import { Button } from '@/shared/ui/button';
import { useChangeStatus } from '../model/use-change-status';

const LABEL: Record<TicketStatus, string> = {
  open: 'Reopen',
  in_progress: 'Start work',
  done: 'Mark done',
  cancelled: 'Cancel',
};

export function ChangeStatusButtons({ ticketId, status }: { ticketId: string; status: TicketStatus }) {
  const change = useChangeStatus(ticketId, status);
  return (
    <div className="flex flex-wrap gap-2">
      {ALLOWED_TRANSITIONS[status].map((to) => (
        <Button key={to} variant={to === 'cancelled' ? 'destructive' : 'default'} onClick={() => change(to)}>
          {LABEL[to]}
        </Button>
      ))}
    </div>
  );
}
