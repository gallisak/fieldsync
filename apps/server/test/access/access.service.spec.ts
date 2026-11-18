import type { QueryResultRow } from 'pg';
import { AccessService, type Queryable } from '../../src/access/access.service';
import type { AuthUser } from '../../src/auth';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const C = '00000000-0000-4000-8000-0000000000c1';
const ADMIN: AuthUser = { id: 'admin', role: 'admin' };
const TECH: AuthUser = { id: 'tech', role: 'technician' };
const NEWBIE: AuthUser = { id: 'newbie', role: 'technician' };

/** Answers the two queries AccessService makes from fixed `sites` and `user_sites` tables. */
const db = (sites: string[], userSites: [string, string][]): Queryable => ({
  async query<R extends QueryResultRow>(text: string, values: unknown[] = []): Promise<{ rows: R[] }> {
    if (/FROM sites/.test(text)) return { rows: sites.map((id) => ({ id })) as unknown as R[] };
    if (/FROM user_sites WHERE user_id = \$1/.test(text)) {
      const rows = userSites.filter(([user]) => user === values[0]).map(([, site_id]) => ({ site_id }));
      return { rows: rows as unknown as R[] };
    }
    throw new Error(`unexpected query: ${text}`);
  },
});

describe('AccessService', () => {
  const access = new AccessService();
  const q = db(
    [A, B, C],
    [
      [TECH.id, A],
      [TECH.id, B],
      ['someone else', C],
    ],
  );

  it('gives an admin every site', async () => {
    expect(await access.accessibleSites(q, ADMIN)).toEqual(new Set([A, B, C]));
  });

  it('gives a technician only their own user_sites rows', async () => {
    expect(await access.accessibleSites(q, TECH)).toEqual(new Set([A, B]));
  });

  it('gives a technician without sites an empty set', async () => {
    expect(await access.accessibleSites(q, NEWBIE)).toEqual(new Set());
  });

  it('fingerprints a site set: stable under order, different when a site is added or removed', () => {
    const fp = access.fingerprint(TECH, [A, B]);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(access.fingerprint(TECH, [B, A])).toBe(fp);
    expect(access.fingerprint(TECH, [A, B, C])).not.toBe(fp);
    expect(access.fingerprint(TECH, [A])).not.toBe(fp);
    expect(access.fingerprint(ADMIN, [A, B])).not.toBe(fp);
  });
});
