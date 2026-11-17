import { MUTATORS } from '../../src';
import { MapTx } from '../support/map-tx';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '11111111-1111-4111-8111-111111111111';

/** F19: deleting a ticket leaves its parts behind; they are replicated to every client forever. */
describe('F19 orphan parts', () => {
  it.failing('deletes the parts of a deleted ticket', () => {
    const tx = new MapTx([
      ['ticket', { id: TICKET, siteId: SITE, title: 'Pump', description: '', status: 'open' }],
      ['part', { id: '22222222-2222-4222-8222-000000000001', ticketId: TICKET, siteId: SITE, name: 'Seal', quantity: 1 }],
      ['part', { id: '22222222-2222-4222-8222-000000000002', ticketId: TICKET, siteId: SITE, name: 'Bolt', quantity: 4 }],
    ]);

    MUTATORS['ticket.delete'].apply(tx, { id: TICKET, siteId: SITE });

    expect(tx.get('ticket', TICKET)).toBeUndefined();
    expect(tx.all('part')).toEqual([]);
  });
});
