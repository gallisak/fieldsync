import { getMutator } from '../../src';
import { MapTx } from '../support/map-tx';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '11111111-1111-4111-8111-111111111111';
const ctx = { now: '2026-01-01T00:00:00.000Z' };

/**
 * F18: `ticket.update` writes title and description wholesale from the editor's form state, which was
 * initialised from the ticket once. Two users editing different fields overwrite each other.
 */
describe('F18 concurrent edits of different fields', () => {
  it('keeps both edits', () => {
    const original = { id: TICKET, siteId: SITE, title: 'Pump', description: 'Old notes', status: 'open' };
    const tx = new MapTx([['ticket', original]]);

    // Each user changes one field and sends only that field.
    const update = getMutator('ticket.update')!;
    update.apply(tx, { id: TICKET, patch: { title: 'Pump #3' } }, ctx);
    update.apply(tx, { id: TICKET, patch: { description: 'Seal replaced' } }, ctx);

    expect(tx.get('ticket', TICKET)).toMatchObject({ title: 'Pump #3', description: 'Seal replaced' });
  });
});
