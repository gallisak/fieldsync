import { getMutator, type Key, type QueuedMutation, type Row } from '@fieldsync/sync-core';
import { ticketSchema, type Ticket } from './types';

type View = ReadonlyMap<string, Row>;

export function selectTickets(view: View): Ticket[] {
  const out: Ticket[] = [];
  for (const [key, row] of view) {
    if (!key.startsWith('ticket/')) continue;
    const parsed = ticketSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function selectTicket(view: View, id: string): Ticket | null {
  const parsed = ticketSchema.safeParse(view.get(`ticket/${id}`));
  return parsed.success ? parsed.data : null;
}

const keysRead = (m: QueuedMutation): Key[] => {
  try {
    return getMutator(m.name)?.reads(m.args) ?? [];
  } catch {
    return [];
  }
};

/** Keys (`"ticket/<id>"`, `"part/<id>"`) of rows with changes the server has not confirmed yet. */
export function selectPendingKeys(pending: readonly QueuedMutation[]): Set<string> {
  const keys = new Set<string>();
  for (const m of pending) for (const k of keysRead(m)) keys.add(`${k.entity}/${k.id}`);
  return keys;
}
