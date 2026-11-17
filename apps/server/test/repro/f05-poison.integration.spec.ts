import { randomUUID } from 'crypto';
import { DEMO, TOKENS, createTicket, push, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

/**
 * F5: a mutation rejected by its mutator (MutationRejected) is never caught: the request fails with 500 and
 * last_mutation_id is not advanced, so the client retries the same head of the queue forever.
 */
describeDb('F5 rejected mutation inside a batch', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
  });
  afterAll(() => t?.close());

  it('rejects the bad mutation and applies the ones around it', async () => {
    const ticketId = await createTicket(t.http, {
      token: TOKENS.admin,
      clientId: 'setup',
      mutationId: 1,
      siteId: DEMO.siteA,
      title: 'F5 ticket',
    });

    const res = await push(t.http, TOKENS.admin, 'c1', [
      { id: 1, name: 'ticket.create', args: { id: randomUUID(), siteId: DEMO.siteA, title: 'F5 other', description: '' } },
      // The ticket is "open", so a transition declared from "done" is a status conflict.
      { id: 2, name: 'ticket.setStatus', args: { id: ticketId, from: 'done', to: 'open' } },
      { id: 3, name: 'ticket.update', args: { id: ticketId, patch: { title: 'F5 updated' } } },
    ]);

    expect([200, 201]).toContain(res.status);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'rejected', 'applied']);
    expect(res.body.results[1]).toMatchObject({ code: 'STATUS_CONFLICT' });
    expect(res.body.lastMutationId).toBe(3);
  });
});
