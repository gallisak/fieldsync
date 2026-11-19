import type { Row, StoredRejection } from '@fieldsync/sync-core';

type View = ReadonlyMap<string, Row>;

export interface RejectionGroup {
  ticketId: string | null;
  title: string | null;
  rejections: StoredRejection[];
}

function ticketIdOf(r: StoredRejection, view: View): string | null {
  const { name, args } = r.mutation;
  if (name.startsWith('ticket.')) return typeof args.id === 'string' ? args.id : null;
  if (name === 'part.add') return typeof args.ticketId === 'string' ? args.ticketId : null;
  if (name === 'part.adjust') {
    const ticketId = view.get(`part/${String(args.id)}`)?.ticketId;
    return typeof ticketId === 'string' ? ticketId : null;
  }
  return null;
}

export function groupRejections(rejections: readonly StoredRejection[], view: View): RejectionGroup[] {
  const groups = new Map<string | null, RejectionGroup>();
  for (const r of rejections) {
    const ticketId = ticketIdOf(r, view);
    let group = groups.get(ticketId);
    if (!group) {
      const title = ticketId === null ? undefined : view.get(`ticket/${ticketId}`)?.title;
      group = { ticketId, title: typeof title === 'string' ? title : null, rejections: [] };
      groups.set(ticketId, group);
    }
    group.rejections.push(r);
  }
  return [...groups.values()];
}
