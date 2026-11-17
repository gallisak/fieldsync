import type { MutatorName } from '../protocol/types';
import type { MutatorDef } from './define';
import { addPart, adjustPart } from './part';
import { createTicket, deleteTicket, moveTicket, setTicketStatus, updateTicket } from './ticket';

export * from './define';
export * from './schemas';
export { ALLOWED_TRANSITIONS } from './transitions';

/** A Map, not an object: `constructor` or `__proto__` must never resolve to a mutator (F6). */
export const MUTATORS: ReadonlyMap<MutatorName, MutatorDef> = new Map<MutatorName, MutatorDef>([
  ['ticket.create', createTicket],
  ['ticket.update', updateTicket],
  ['ticket.setStatus', setTicketStatus],
  ['ticket.delete', deleteTicket],
  ['ticket.move', moveTicket],
  ['part.add', addPart],
  ['part.adjust', adjustPart],
]);

export function getMutator(name: string): MutatorDef | undefined {
  return MUTATORS.get(name as MutatorName);
}
