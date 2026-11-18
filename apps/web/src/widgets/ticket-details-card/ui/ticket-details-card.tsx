'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useViewer } from '@/entities/session';
import { TicketStatusBadge, usePendingKeys, useTicket } from '@/entities/ticket';
import { ChangeStatusButtons } from '@/features/ticket/change-status';
import { DeleteTicketButton } from '@/features/ticket/delete';
import { EditTicketFields } from '@/features/ticket/edit-fields';
import { MoveTicketMenuItem } from '@/features/ticket/move-site';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/shared/ui/dropdown-menu';

export function TicketDetailsCard({ id }: { id: string }) {
  const ticket = useTicket(id);
  const { sites } = useViewer();
  const pending = usePendingKeys();
  const router = useRouter();

  if (!ticket) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Ticket unavailable</CardTitle>
          <CardDescription>It was deleted, moved, or you no longer have access.</CardDescription>
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
            <DropdownMenuContent align="end" className="space-y-1">
              <MoveTicketMenuItem ticketId={ticket.id} currentSiteId={ticket.siteId} sites={sites} />
              <div className="p-1">
                <DeleteTicketButton ticketId={ticket.id} onDeleted={() => router.push('/')} />
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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
