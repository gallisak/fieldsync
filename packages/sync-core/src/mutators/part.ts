import { MutationRejected, defineMutator } from './define';
import { MAX_PART_QUANTITY, addPartArgs, adjustPartArgs } from './schemas';

export const addPart = defineMutator({
  args: addPartArgs,
  reads: (a) => [
    { entity: 'ticket', id: a.ticketId },
    { entity: 'part', id: a.id },
  ],
  apply(tx, a) {
    const ticket = tx.get('ticket', a.ticketId);
    if (!ticket) throw new MutationRejected('NO_ACCESS', 'Ticket is unavailable: deleted, moved, or access revoked');
    const existing = tx.get('part', a.id);
    // The same id on the same ticket is a retry of this add; anything else is another part, live or deleted.
    if (existing?.ticketId === a.ticketId) return;
    if (existing || tx.exists('part', a.id)) {
      throw new MutationRejected('ALREADY_EXISTS', 'A part with this id already exists');
    }
    tx.put('part', a.id, { id: a.id, ticketId: a.ticketId, siteId: ticket.siteId, name: a.name, quantity: a.quantity });
  },
});

export const adjustPart = defineMutator({
  args: adjustPartArgs,
  reads: (a) => [{ entity: 'part', id: a.id }],
  apply(tx, a) {
    const part = tx.get('part', a.id);
    if (!part) throw new MutationRejected('NO_ACCESS', 'Part is unavailable: deleted, moved, or access revoked');
    const quantity = (part.quantity as number) + a.delta;
    if (quantity < 0) throw new MutationRejected('NEGATIVE_QUANTITY', 'Quantity cannot go below zero');
    if (quantity > MAX_PART_QUANTITY) {
      throw new MutationRejected('BAD_ARGS', `Quantity cannot go above ${MAX_PART_QUANTITY}`);
    }
    tx.put('part', a.id, { ...part, quantity });
  },
});
