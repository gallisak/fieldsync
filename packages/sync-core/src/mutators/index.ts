import type { EntityName, MutatorName, Row, TicketStatus } from '../protocol/types';

export class MutationRejected extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'MutationRejected';
  }
}

export interface Key {
  entity: EntityName;
  id: string;
}

/** State access given to a mutator. Reads are served from rows loaded up front. */
export interface MutatorTx {
  get(entity: EntityName, id: string): Row | undefined;
  put(entity: EntityName, id: string, row: Row): void;
  del(entity: EntityName, id: string): void;
}

export interface MutatorDef {
  /** Rows the mutator needs to read; the executor loads them before calling apply. */
  reads(args: Record<string, unknown>): Key[];
  apply(tx: MutatorTx, args: Record<string, unknown>): void;
}

function def<A>(d: { reads(a: A): Key[]; apply(tx: MutatorTx, a: A): void }): MutatorDef {
  return d as unknown as MutatorDef;
}

export const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['done', 'open', 'cancelled'],
  done: ['open'],
  cancelled: [],
};

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new MutationRejected('BAD_ARGS', `${field} must be a non-empty string up to ${max} chars`);
  }
  return value;
}

const now = () => new Date().toISOString();

interface CreateArgs { siteId: string; title: string; description: string }
interface UpdateArgs { id: string; siteId: string; title: string; description: string }
interface StatusArgs { id: string; siteId: string; from: TicketStatus; to: TicketStatus }
interface DeleteArgs { id: string; siteId: string }
interface PartAddArgs { id: string; ticketId: string; siteId: string; name: string; quantity: number }
interface PartAdjustArgs { id: string; siteId: string; delta: number }

export const MUTATORS: Record<MutatorName, MutatorDef> = {
  'ticket.create': def<CreateArgs>({
    reads: () => [],
    apply(tx, a) {
      const id = globalThis.crypto.randomUUID();
      const ts = now();
      tx.put('ticket', id, {
        id,
        siteId: a.siteId,
        title: text(a.title, 200, 'title'),
        description: typeof a.description === 'string' ? a.description.slice(0, 5000) : '',
        status: 'open',
        assigneeId: null,
        createdAt: ts,
        updatedAt: ts,
      });
    },
  }),

  'ticket.update': def<UpdateArgs>({
    reads: (a) => [{ entity: 'ticket', id: a.id }],
    apply(tx, a) {
      const ticket = tx.get('ticket', a.id);
      if (!ticket) throw new MutationRejected('NOT_FOUND', 'Ticket no longer exists');
      tx.put('ticket', a.id, {
        ...ticket,
        title: text(a.title, 200, 'title'),
        description: typeof a.description === 'string' ? a.description.slice(0, 5000) : '',
        updatedAt: now(),
      });
    },
  }),

  'ticket.setStatus': def<StatusArgs>({
    reads: (a) => [{ entity: 'ticket', id: a.id }],
    apply(tx, a) {
      const ticket = tx.get('ticket', a.id);
      if (!ticket) throw new MutationRejected('NOT_FOUND', 'Ticket no longer exists');
      if (ticket.status !== a.from) {
        throw new MutationRejected('STATUS_CONFLICT', `Status is now "${String(ticket.status)}"`);
      }
      if (!ALLOWED_TRANSITIONS[a.from]?.includes(a.to)) {
        throw new MutationRejected('INVALID_TRANSITION', `${a.from} -> ${a.to} is not allowed`);
      }
      tx.put('ticket', a.id, { ...ticket, status: a.to, updatedAt: now() });
    },
  }),

  'ticket.delete': def<DeleteArgs>({
    reads: (a) => [{ entity: 'ticket', id: a.id }],
    apply(tx, a) {
      if (!tx.get('ticket', a.id)) return;
      tx.del('ticket', a.id);
    },
  }),

  'part.add': def<PartAddArgs>({
    reads: (a) => [
      { entity: 'ticket', id: a.ticketId },
      { entity: 'part', id: a.id },
    ],
    apply(tx, a) {
      const ticket = tx.get('ticket', a.ticketId);
      if (!ticket) throw new MutationRejected('NOT_FOUND', 'Ticket no longer exists');
      if (tx.get('part', a.id)) return;
      if (!Number.isInteger(a.quantity) || a.quantity < 1 || a.quantity > 1000) {
        throw new MutationRejected('BAD_ARGS', 'quantity must be an integer from 1 to 1000');
      }
      tx.put('part', a.id, {
        id: a.id,
        ticketId: a.ticketId,
        siteId: ticket.siteId,
        name: text(a.name, 100, 'name'),
        quantity: a.quantity,
      });
    },
  }),

  'part.adjust': def<PartAdjustArgs>({
    reads: (a) => [{ entity: 'part', id: a.id }],
    apply(tx, a) {
      const part = tx.get('part', a.id);
      if (!part) throw new MutationRejected('NOT_FOUND', 'Part no longer exists');
      if (!Number.isInteger(a.delta) || Math.abs(a.delta) > 1000) {
        throw new MutationRejected('BAD_ARGS', 'delta must be an integer between -1000 and 1000');
      }
      const quantity = (part.quantity as number) + a.delta;
      if (quantity < 0) throw new MutationRejected('NEGATIVE_QUANTITY', 'Quantity cannot go below zero');
      tx.put('part', a.id, { ...part, quantity });
    },
  }),
};
