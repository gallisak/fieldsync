'use client';

import { AppHeader } from '@/widgets/app-header';
import { RejectionInbox } from '@/widgets/rejection-inbox';
import { TicketDetailsCard } from '@/widgets/ticket-details-card';
import { TicketParts } from '@/widgets/ticket-parts';

export function TicketDetailsPage({ params: { id } }: { params: { id: string } }) {
  return (
    <>
      <AppHeader inbox={(trigger) => <RejectionInbox trigger={trigger} />} />
      <main className="mx-auto max-w-5xl space-y-4 p-4">
        <TicketDetailsCard id={id} />
        <TicketParts ticketId={id} />
      </main>
    </>
  );
}
