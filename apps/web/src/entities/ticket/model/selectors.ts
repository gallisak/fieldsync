import { getMutator, type Key, type QueuedMutation, type Row } from '@fieldsync/sync-core';
import { cachedParser } from '@/shared/lib/parse-cache';
import { ticketSchema, type Ticket } from './types';

type View = ReadonlyMap<string, Row>;

const parseTicket = cachedParser(ticketSchema);

export function selectTickets(view: View): Ticket[] {
  const out: Ticket[] = [];
  for (const [key, row] of view) {
    if (!key.startsWith('ticket/')) continue;
    const ticket = parseTicket(row);
    if (ticket) out.push(ticket);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function selectTicket(view: View, id: string): Ticket | null {
  return parseTicket(view.get(`ticket/${id}`));
}

const keysRead = (m: QueuedMutation): Key[] => {
  try {
    return getMutator(m.name)?.reads(m.args) ?? [];
  } catch {
    return [];
  }
};

export function selectPendingKeys(pending: readonly QueuedMutation[]): Set<string> {
  const keys = new Set<string>();
  for (const m of pending) for (const k of keysRead(m)) keys.add(`${k.entity}/${k.id}`);
  return keys;
}
