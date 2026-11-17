import { MutationRejected } from '@fieldsync/sync-core';
import { authorize } from '../src/access';

const SITE_A = '00000000-0000-4000-8000-0000000000a1';
const SITE_B = '00000000-0000-4000-8000-0000000000b1';
const TECH = { id: 'u1', role: 'technician' as const };

function fakeDb(sites: string[]) {
  return { query: async () => ({ rows: sites.map((s) => ({ site_id: s })) }) } as never;
}

describe('authorize', () => {
  it('allows a mutation on an accessible site', async () => {
    await expect(
      authorize(fakeDb([SITE_A]), TECH, { id: 1, name: 'ticket.setStatus', args: { id: 'x', siteId: SITE_A, status: 'done' } }),
    ).resolves.toBeUndefined();
  });

  it('rejects a mutation on a site the user cannot access', async () => {
    await expect(
      authorize(fakeDb([SITE_A]), TECH, { id: 1, name: 'ticket.setStatus', args: { id: 'x', siteId: SITE_B, status: 'done' } }),
    ).rejects.toBeInstanceOf(MutationRejected);
  });
});
