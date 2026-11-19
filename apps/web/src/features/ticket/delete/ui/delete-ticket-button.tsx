'use client';

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
import type { ReactElement } from 'react';
import { Button } from '@/shared/ui/button';
import { useDeleteTicket } from '../model/use-delete-ticket';

interface DeleteTicketButtonProps {
  ticketId: string;
  onDeleted?: () => void;
  trigger?: ReactElement;
}

export function DeleteTicketButton({ ticketId, onDeleted, trigger }: DeleteTicketButtonProps) {
  const remove = useDeleteTicket(ticketId);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger ?? <Button variant="destructive">Delete</Button>}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this ticket?</AlertDialogTitle>
          <AlertDialogDescription>The ticket and its parts are removed for everyone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              if (await remove()) onDeleted?.();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
