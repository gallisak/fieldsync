import Link from 'next/link';
import { formatRelative } from '@/shared/lib/relative-time';
import { Badge } from '@/shared/ui/badge';
import { TableCell, TableRow } from '@/shared/ui/table';
import type { Ticket } from '../model/types';
import { TicketStatusBadge } from './ticket-status-badge';

interface TicketRowProps {
  ticket: Ticket;
  siteName: string;
  unsynced: boolean;
}

export function TicketRow({ ticket, siteName, unsynced }: TicketRowProps) {
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
        <time dateTime={ticket.updatedAt}>{formatRelative(ticket.updatedAt)}</time>
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
}
