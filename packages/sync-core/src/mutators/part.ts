import { MutationRejected, defineMutator } from './define';
import { addPartArgs, adjustPartArgs } from './schemas';

/** The part inherits the ticket's site; adding an id that already exists is a no-op. */
export const addPart = defineMutator({
  args: addPartArgs,
  reads: (a) => [
    { entity: 'ticket', id: a.ticketId },
    { entity: 'part', id: a.id },
  ],
  apply(tx, a) {
    const ticket = tx.get('ticket', a.ticketId);
    if (!ticket) throw new MutationRejected('NO_ACCESS', 'Ticket is unavailable: deleted, moved, or access revoked');
    if (tx.get('part', a.id)) return;
    tx.put('part', a.id, { id: a.id, ticketId: a.ticketId, siteId: ticket.siteId, name: a.name, quantity: a.quantity });
  },
});

/** A delta rather than an absolute value, so concurrent adjustments commute. */
export const adjustPart = defineMutator({
  args: adjustPartArgs,
  reads: (a) => [{ entity: 'part', id: a.id }],
  apply(tx, a) {
    const part = tx.get('part', a.id);
    if (!part) throw new MutationRejected('NO_ACCESS', 'Part is unavailable: deleted, moved, or access revoked');
    const quantity = (part.quantity as number) + a.delta;
    if (quantity < 0) throw new MutationRejected('NEGATIVE_QUANTITY', 'Quantity cannot go below zero');
    tx.put('part', a.id, { ...part, quantity });
  },
});
