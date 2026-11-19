'use client';

import { ALLOWED_TRANSITIONS, type TicketStatus } from '@fieldsync/sync-core';
import { useEffect, useState } from 'react';
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
import { useChangeStatus } from '../model/use-change-status';

// The buttons change with the status, so the second click of a double click would land on the next transition's button.
const SETTLE_MS = 600;

const LABEL: Record<TicketStatus, string> = {
  open: 'Reopen',
  in_progress: 'Start work',
  done: 'Mark done',
  cancelled: 'Cancel ticket',
};

export function ChangeStatusButtons({ ticketId, status }: { ticketId: string; status: TicketStatus }) {
  const change = useChangeStatus(ticketId, status);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settling]);
  const go = (to: TicketStatus) => {
    setSettling(true);
    change(to);
  };
  return (
    <div className="flex flex-wrap gap-2">
      {ALLOWED_TRANSITIONS[status].map((to) =>
        to === 'cancelled' ? (
          <AlertDialog key={to}>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={settling}>
                {LABEL[to]}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancel this ticket?</AlertDialogTitle>
                <AlertDialogDescription>A cancelled ticket cannot change status again.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction onClick={() => go(to)}>Cancel ticket</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button key={to} disabled={settling} onClick={() => go(to)}>
            {LABEL[to]}
          </Button>
        ),
      )}
    </div>
  );
}
