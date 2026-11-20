import Link from 'next/link';
import { memo } from 'react';
import { Badge } from '@/shared/ui/badge';
import { RelativeTime } from '@/shared/ui/relative-time';
import { TableCell, TableRow } from '@/shared/ui/table';
import type { Ticket } from '../model/types';
import { TicketStatusBadge } from './ticket-status-badge';

interface TicketRowProps {
  ticket: Ticket;
  siteName: string;
  unsynced: boolean;
}

export const TicketRow = memo(function TicketRow({ ticket, siteName, unsynced }: TicketRowProps) {
  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link href={`/tickets/${ticket.id}`} prefetch={false} className="hover:underline">
          {ticket.title}
        </Link>
      </TableCell>
      <TableCell>
        <TicketStatusBadge status={ticket.status} />
      </TableCell>
      <TableCell>{siteName}</TableCell>
      <TableCell className="text-muted-foreground">
        <RelativeTime iso={ticket.updatedAt} />
      </TableCell>
      <TableCell>
        {unsynced && (
          <Badge variant="outline" className="text-muted-foreground">
            Not synced
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
});
