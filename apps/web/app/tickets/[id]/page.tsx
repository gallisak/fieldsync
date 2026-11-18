'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PartRow, usePartsOfTicket } from '@/entities/part';
import { RejectionItem, useRejections } from '@/entities/rejection';
import { useViewer } from '@/entities/session';
import { TicketStatusBadge, usePendingKeys, useTicket } from '@/entities/ticket';
import { SignOutButton } from '@/features/auth/sign-out';
import { AddPartForm } from '@/features/part/add';
import { AdjustQuantityButtons } from '@/features/part/adjust-quantity';
import { ResolveRejectionActions } from '@/features/rejection/resolve';
import { ChangeStatusButtons } from '@/features/ticket/change-status';
import { DeleteTicketButton } from '@/features/ticket/delete';
import { EditTicketFields } from '@/features/ticket/edit-fields';
import { MoveTicketMenuItem } from '@/features/ticket/move-site';
import { useSyncStatus } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/shared/ui/dropdown-menu';

export default function TicketPage({ params: { id } }: { params: { id: string } }) {
  const router = useRouter();
  const ticket = useTicket(id);
  const parts = usePartsOfTicket(id);
  const pending = usePendingKeys();
  const rejections = useRejections();
  const { sites } = useViewer();
  const { badge, facts } = useSyncStatus();

  if (!ticket) {
    return (
      <main className="mx-auto max-w-3xl space-y-4 p-4">
        <p>Ticket unavailable.</p>
        <Link href="/">Back</Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4">
      <Link href="/">← All tickets</Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{ticket.title}</h1>
        <div className="flex items-center gap-2">
          <TicketStatusBadge status={ticket.status} />
          {sites.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">More</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <MoveTicketMenuItem ticketId={ticket.id} currentSiteId={ticket.siteId} sites={sites} />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DeleteTicketButton ticketId={ticket.id} onDeleted={() => router.push('/')} />
          <SignOutButton />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {badge} · {facts.pendingCount} pending · site {sites.find((s) => s.id === ticket.siteId)?.name ?? 'unknown'}
      </p>
      <ChangeStatusButtons ticketId={ticket.id} status={ticket.status} />
      <EditTicketFields key={ticket.id} ticket={ticket} />

      <section className="space-y-2">
        <h2 className="font-semibold">Parts</h2>
        {parts.map((p) => (
          <PartRow
            key={p.id}
            part={p}
            unsynced={pending.has(`part/${p.id}`)}
            actions={<AdjustQuantityButtons partId={p.id} quantity={p.quantity} />}
          />
        ))}
        <AddPartForm ticketId={ticket.id} />
      </section>

      {rejections.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Rejected changes</h2>
          {rejections.map((r) => (
            <RejectionItem key={r.mutation.id} rejection={r} actions={<ResolveRejectionActions rejection={r} />} />
          ))}
        </section>
      )}
    </main>
  );
}
