'use client';

import { AppHeader } from '@/widgets/app-header';
import { RejectionInbox } from '@/widgets/rejection-inbox';
import { TicketTable } from '@/widgets/ticket-table';

export function TicketListPage() {
  return (
    <>
      <AppHeader inbox={(trigger) => <RejectionInbox trigger={trigger} />} />
      <main className="mx-auto max-w-5xl p-4">
        <TicketTable />
      </main>
    </>
  );
}
