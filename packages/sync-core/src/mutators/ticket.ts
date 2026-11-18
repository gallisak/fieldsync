import type { Row, TicketStatus } from '../protocol/types';
import { MutationRejected, defineMutator, type MutatorTx } from './define';
import { createTicketArgs, deleteTicketArgs, moveTicketArgs, setStatusArgs, updateTicketArgs } from './schemas';
import { ALLOWED_TRANSITIONS } from './transitions';

/** Same answer for "never existed", "deleted", "moved away" and "no access", so ids cannot be probed. */
function requireTicket(tx: MutatorTx, id: string): Row {
  const ticket = tx.get('ticket', id);
  if (!ticket) throw new MutationRejected('NO_ACCESS', 'Ticket is unavailable: deleted, moved, or access revoked');
  return ticket;
}

export const createTicket = defineMutator({
  args: createTicketArgs,
  reads: (a) => [{ entity: 'ticket', id: a.id }],
  apply(tx, a, ctx) {
    // A deleted id is taken too: reviving it would hand an old ticket's id to new content.
    if (tx.exists('ticket', a.id)) throw new MutationRejected('ALREADY_EXISTS', 'A ticket with this id already exists');
    tx.put('ticket', a.id, {
      id: a.id,
      siteId: a.siteId,
      title: a.title,
      description: a.description,
      status: 'open',
      assigneeId: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
  },
});

/** Writes only the fields present in the patch, so concurrent edits of different fields both survive (F18). */
export const updateTicket = defineMutator({
  args: updateTicketArgs,
  reads: (a) => [{ entity: 'ticket', id: a.id }],
  apply(tx, a, ctx) {
    const next: Row = { ...requireTicket(tx, a.id) };
    for (const [field, value] of Object.entries(a.patch)) {
      if (value !== undefined) next[field] = value;
    }
    next.updatedAt = ctx.now;
    tx.put('ticket', a.id, next);
  },
});

export const setTicketStatus = defineMutator({
  args: setStatusArgs,
  reads: (a) => [{ entity: 'ticket', id: a.id }],
  apply(tx, a, ctx) {
    const ticket = requireTicket(tx, a.id);
    const current = ticket.status as TicketStatus;
    if (current !== a.from) {
      throw new MutationRejected('STATUS_CONFLICT', `Status is now "${current}"`, { current });
    }
    if (!ALLOWED_TRANSITIONS[a.from].includes(a.to)) {
      throw new MutationRejected('INVALID_TRANSITION', `${a.from} → ${a.to} is not allowed`);
    }
    tx.put('ticket', a.id, { ...ticket, status: a.to, updatedAt: ctx.now });
  },
});

/** Idempotent; removes the ticket's parts too (F19). */
export const deleteTicket = defineMutator({
  args: deleteTicketArgs,
  reads: (a) => [{ entity: 'ticket', id: a.id }],
  scans: (a) => [{ entity: 'part', by: { ticketId: a.id } }],
  apply(tx, a) {
    if (!tx.get('ticket', a.id)) return;
    for (const part of tx.scan('part', { ticketId: a.id })) tx.del('part', String(part.id));
    tx.del('ticket', a.id);
  },
});

export const moveTicket = defineMutator({
  args: moveTicketArgs,
  reads: (a) => [{ entity: 'ticket', id: a.id }],
  scans: (a) => [{ entity: 'part', by: { ticketId: a.id } }],
  apply(tx, a, ctx) {
    const ticket = requireTicket(tx, a.id);
    if (ticket.siteId === a.toSiteId) return;
    tx.put('ticket', a.id, { ...ticket, siteId: a.toSiteId, updatedAt: ctx.now });
    for (const part of tx.scan('part', { ticketId: a.id })) {
      tx.put('part', String(part.id), { ...part, siteId: a.toSiteId });
    }
  },
});
