import { ALLOWED_TRANSITIONS, type TicketStatus } from '../../src';
import { MapTx } from '../support/map-tx';
import { expectRejected, run } from '../support/mutate';

const TICKET = '11111111-1111-4111-8111-111111111111';
const STATUSES: TicketStatus[] = ['open', 'in_progress', 'done', 'cancelled'];
// Written out, not derived from ALLOWED_TRANSITIONS: a change to the table must show up here.
const ALLOWED = new Set(['open→in_progress', 'open→cancelled', 'in_progress→done', 'in_progress→open', 'in_progress→cancelled', 'done→open']);
const PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to, ALLOWED.has(`${from}→${to}`)] as const));

describe('status state machine', () => {
  it.each(PAIRS)('%s → %s allowed: %s', (from, to, allowed) => {
    const tx = new MapTx([['ticket', { id: TICKET, status: from }]]);
    const args = { id: TICKET, from, to };
    expect(ALLOWED_TRANSITIONS[from].includes(to)).toBe(allowed);
    if (allowed) {
      run(tx, 'ticket.setStatus', args);
      expect(tx.get('ticket', TICKET)?.status).toBe(to);
    } else {
      expectRejected(tx, 'ticket.setStatus', args, 'INVALID_TRANSITION');
      expect(tx.get('ticket', TICKET)?.status).toBe(from);
    }
  });

  it('has no transition out of cancelled and none to the same status', () => {
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
    for (const s of STATUSES) expect(ALLOWED_TRANSITIONS[s]).not.toContain(s);
  });
});
