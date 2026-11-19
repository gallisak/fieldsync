'use client';

import { usePathname } from 'next/navigation';
import { AppHeader } from '@/widgets/app-header';
import { RejectionInbox } from '@/widgets/rejection-inbox';
import { TicketDetailsCard } from '@/widgets/ticket-details-card';
import { TicketParts } from '@/widgets/ticket-parts';

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/** The id comes from the address, not the params: offline, one cached ticket document answers every ticket URL. */
export function TicketDetailsPage() {
  const id = decodeSegment(usePathname()?.split('/')[2] ?? '');
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
