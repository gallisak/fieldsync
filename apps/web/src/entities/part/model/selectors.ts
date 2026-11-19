import type { Row } from '@fieldsync/sync-core';
import { partSchema, type Part } from './types';

type View = ReadonlyMap<string, Row>;

export function selectPartsOfTicket(view: View, ticketId: string): Part[] {
  const out: Part[] = [];
  for (const [key, row] of view) {
    if (!key.startsWith('part/') || row.ticketId !== ticketId) continue;
    const parsed = partSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
