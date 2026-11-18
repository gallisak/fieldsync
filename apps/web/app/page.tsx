'use client';

import { useViewer } from '@/entities/session';
import { TicketRow, usePendingKeys, useTickets } from '@/entities/ticket';
import { SignOutButton } from '@/features/auth/sign-out';
import { CreateTicketDialog } from '@/features/ticket/create';
import { useSyncStatus } from '@/shared/api';
import { Table, TableBody } from '@/shared/ui/table';

export default function HomePage() {
  const tickets = useTickets();
  const pending = usePendingKeys();
  const { sites } = useViewer();
  const { badge, facts } = useSyncStatus();

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Tickets</h1>
        <div className="flex items-center gap-2">
          <CreateTicketDialog sites={sites} />
          <SignOutButton />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {badge} · {facts.pendingCount} pending
        {facts.storage === 'memory' ? ' · this browser cannot store data: changes are lost on reload' : ''}
      </p>
      {tickets.length === 0 ? (
        <p>No tickets yet.</p>
      ) : (
        <Table>
          <TableBody>
            {tickets.map((t) => (
              <TicketRow
                key={t.id}
                ticket={t}
                siteName={sites.find((s) => s.id === t.siteId)?.name ?? 'Unknown site'}
                unsynced={pending.has(`ticket/${t.id}`)}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
