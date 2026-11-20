'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useViewer } from '@/entities/session';
import { TicketStatusBadge, usePendingKeys, useTicket } from '@/entities/ticket';
import { AssignTicket } from '@/features/ticket/assign';
import { ChangeStatusButtons } from '@/features/ticket/change-status';
import { DeleteTicketButton } from '@/features/ticket/delete';
import { EditTicketFields } from '@/features/ticket/edit-fields';
import { MoveTicketMenuItem } from '@/features/ticket/move-site';
import { useHasSynced } from '@/shared/api';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/shared/ui/dropdown-menu';
import { SyncLoadingCard } from '@/shared/ui/loading-card';

export function TicketDetailsCard({ id }: { id: string }) {
  const ticket = useTicket(id);
  const { sites } = useViewer();
  const pending = usePendingKeys();
  const router = useRouter();
  const synced = useHasSynced();

  // A change still queued for it means this device removed it: deleted here, not lost or not loaded yet.
  const deletedHere = !ticket && pending.has(`ticket/${id}`);
  if (!ticket && !synced && !deletedHere) return <SyncLoadingCard title="Ticket" />;
  if (!ticket) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{deletedHere ? 'Ticket deleted' : 'Ticket unavailable'}</CardTitle>
          <CardDescription>
            {deletedHere
              ? 'Deleted on this device; the server learns of it when the device syncs.'
              : 'It was deleted, moved, or you no longer have access.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/" className="text-sm underline">
            Back to tickets
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-2">
            <CardTitle>{ticket.title}</CardTitle>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <TicketStatusBadge status={ticket.status} />
              <span>{sites.find((s) => s.id === ticket.siteId)?.name ?? 'Unknown site'}</span>
              {pending.has(`ticket/${ticket.id}`) && (
                <Badge variant="outline" className="text-muted-foreground">
                  Not synced
                </Badge>
              )}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <MoveTicketMenuItem ticketId={ticket.id} currentSiteId={ticket.siteId} sites={sites} />
              <DeleteTicketButton
                ticketId={ticket.id}
                onDeleted={() => router.push('/')}
                trigger={
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={(e) => e.preventDefault()}>
                    Delete
                  </DropdownMenuItem>
                }
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <AssignTicket ticketId={ticket.id} assigneeId={ticket.assigneeId} />
        {ticket.status === 'cancelled' ? (
          <p className="text-sm text-muted-foreground">This ticket is cancelled; its status can no longer change.</p>
        ) : (
          <ChangeStatusButtons ticketId={ticket.id} status={ticket.status} />
        )}
      </CardHeader>
      <CardContent>
        <EditTicketFields key={ticket.id} ticket={ticket} />
      </CardContent>
    </Card>
  );
}
