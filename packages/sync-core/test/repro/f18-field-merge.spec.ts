import { MUTATORS } from '../../src';
import { MapTx } from '../support/map-tx';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '11111111-1111-4111-8111-111111111111';

/**
 * F18: `ticket.update` writes title and description wholesale from the editor's form state, which was
 * initialised from the ticket once. Two users editing different fields overwrite each other.
 */
describe('F18 concurrent edits of different fields', () => {
  it.failing('keeps both edits', () => {
    const original = { id: TICKET, siteId: SITE, title: 'Pump', description: 'Old notes', status: 'open' };
    const tx = new MapTx([['ticket', original]]);

    // Each user changes one field; the starter UI sends the other field as it was when the form opened.
    MUTATORS['ticket.update'].apply(tx, {
      id: TICKET,
      siteId: SITE,
      title: 'Pump #3',
      description: original.description,
    });
    MUTATORS['ticket.update'].apply(tx, {
      id: TICKET,
      siteId: SITE,
      title: original.title,
      description: 'Seal replaced',
    });

    expect(tx.get('ticket', TICKET)).toMatchObject({ title: 'Pump #3', description: 'Seal replaced' });
  });
});
