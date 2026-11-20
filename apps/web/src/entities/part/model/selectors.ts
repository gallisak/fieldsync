import type { Row } from '@fieldsync/sync-core';
import { cachedParser } from '@/shared/lib/parse-cache';
import { partSchema, type Part } from './types';

type View = ReadonlyMap<string, Row>;

const parsePart = cachedParser(partSchema);

export function selectPartsOfTicket(view: View, ticketId: string): Part[] {
  const out: Part[] = [];
  for (const [key, row] of view) {
    if (!key.startsWith('part/') || row.ticketId !== ticketId) continue;
    const part = parsePart(row);
    if (part) out.push(part);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
