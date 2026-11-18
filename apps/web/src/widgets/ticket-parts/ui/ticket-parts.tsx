'use client';

import { PartRow, usePartsOfTicket } from '@/entities/part';
import { usePendingKeys, useTicket } from '@/entities/ticket';
import { AddPartForm } from '@/features/part/add';
import { AdjustQuantityButtons } from '@/features/part/adjust-quantity';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';

export function TicketParts({ ticketId }: { ticketId: string }) {
  const ticket = useTicket(ticketId);
  const parts = usePartsOfTicket(ticketId);
  const pending = usePendingKeys();

  if (!ticket) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Parts used</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {parts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No parts recorded</p>
        ) : (
          <div className="divide-y">
            {parts.map((p) => (
              <PartRow
                key={p.id}
                part={p}
                unsynced={pending.has(`part/${p.id}`)}
                actions={<AdjustQuantityButtons partId={p.id} quantity={p.quantity} />}
              />
            ))}
          </div>
        )}
        <AddPartForm ticketId={ticketId} />
      </CardContent>
    </Card>
  );
}
