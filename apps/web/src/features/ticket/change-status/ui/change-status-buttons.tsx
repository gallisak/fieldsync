'use client';

import { ALLOWED_TRANSITIONS, type TicketStatus } from '@fieldsync/sync-core';
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

const LABEL: Record<TicketStatus, string> = {
  open: 'Reopen',
  in_progress: 'Start work',
  done: 'Mark done',
  cancelled: 'Cancel ticket',
};

export function ChangeStatusButtons({ ticketId, status }: { ticketId: string; status: TicketStatus }) {
  const change = useChangeStatus(ticketId, status);
  return (
    <div className="flex flex-wrap gap-2">
      {ALLOWED_TRANSITIONS[status].map((to) =>
        to === 'cancelled' ? (
          <AlertDialog key={to}>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">{LABEL[to]}</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancel this ticket?</AlertDialogTitle>
                <AlertDialogDescription>A cancelled ticket cannot change status again.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction onClick={() => change(to)}>Cancel ticket</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button key={to} onClick={() => change(to)}>
            {LABEL[to]}
          </Button>
        ),
      )}
    </div>
  );
}
