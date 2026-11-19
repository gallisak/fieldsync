import type { StoredMutation, StoredRejection, TicketStatus } from '@fieldsync/sync-core';

const STATUS: Record<TicketStatus, string> = {
  open: 'open',
  in_progress: 'in progress',
  done: 'done',
  cancelled: 'cancelled',
};

const STATUS_ACTION: Record<TicketStatus, string> = {
  open: 'Reopen',
  in_progress: 'Start work',
  done: 'Mark done',
  cancelled: 'Cancel',
};

const statusName = (s: unknown): string => STATUS[s as TicketStatus] ?? String(s);
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function describeMutation(m: StoredMutation): string {
  const a = m.args as Record<string, unknown>;
  switch (m.name) {
    case 'ticket.create':
      return `Create ticket "${String(a.title)}"`;
    case 'ticket.update': {
      const patch = (a.patch ?? {}) as Record<string, unknown>;
      const fields = ['title', 'description', 'assigneeId'].filter((f) => patch[f] !== undefined);
      return `Edit ${fields.map((f) => (f === 'assigneeId' ? 'assignee' : f)).join(' and ') || 'ticket'}`;
    }
    case 'ticket.setStatus':
      return STATUS_ACTION[a.to as TicketStatus] ?? 'Change status';
    case 'ticket.delete':
      return 'Delete ticket';
    case 'ticket.move':
      return 'Move ticket to another site';
    case 'part.add':
      return `Add part "${String(a.name)}"`;
    case 'part.adjust': {
      const delta = Number(a.delta);
      return delta >= 0 ? `Add ${delta} to a part's quantity` : `Remove ${-delta} from a part's quantity`;
    }
    default:
      return m.name;
  }
}

export function describeRejection(r: StoredRejection): { title: string; hint: string } {
  const a = r.mutation.args as Record<string, unknown>;
  switch (r.code) {
    case 'STATUS_CONFLICT': {
      const current = (r.details as { current?: unknown } | undefined)?.current;
      return {
        title: 'Status was changed by someone else',
        hint: current === undefined ? r.message : `It is now ${statusName(current)}.`,
      };
    }
    case 'INVALID_TRANSITION':
      return {
        title: 'This status change is not allowed',
        hint: `${capitalized(statusName(a.from))} cannot go to ${statusName(a.to)}.`,
      };
    case 'NEGATIVE_QUANTITY':
      return {
        title: 'Quantity cannot go below zero',
        hint: 'Someone else reduced it first. Check the current quantity.',
      };
    case 'NO_ACCESS':
      return {
        title: 'Ticket is no longer available',
        hint: 'It was deleted, moved to another site, or your access was removed.',
      };
    case 'ALREADY_EXISTS':
      return { title: 'This item already exists', hint: 'Another item already uses its id. Create it again.' };
    case 'BAD_ARGS':
      return { title: 'The change was not valid', hint: r.message };
    case 'INTERNAL':
      return { title: 'Server error', hint: 'Your change was not applied. You can try again.' };
    default:
      return { title: 'The change was rejected', hint: r.message };
  }
}
