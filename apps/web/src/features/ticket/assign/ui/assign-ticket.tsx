'use client';

import { useViewer } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { useAssignTicket } from '../model/use-assign-ticket';

/** The client knows no other user's name: it can say only whether the ticket is the viewer's. */
export function AssignTicket({ ticketId, assigneeId }: { ticketId: string; assigneeId: string | null }) {
  const { id } = useViewer();
  const assign = useAssignTicket(ticketId);
  const mine = assigneeId === id;
  const label = mine ? 'Assigned to you' : assigneeId ? 'Assigned to someone else' : 'Unassigned';
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Button variant="outline" size="sm" onClick={() => assign(mine ? null : id)}>
        {mine ? 'Unassign' : 'Assign to me'}
      </Button>
    </div>
  );
}
