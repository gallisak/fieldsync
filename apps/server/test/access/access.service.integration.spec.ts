import { AccessService } from '../../src/access/access.service';
import { DEMO, seed } from '../support/api';
import { createTestApp, describeDb, type TestApp } from '../support/pg';

describeDb('AccessService.accessibleSites on Postgres', () => {
  let t: TestApp;
  let access: AccessService;
  beforeAll(async () => {
    t = await createTestApp();
    await seed(t.pool);
    access = t.app.get(AccessService);
  });
  afterAll(() => t?.close());

  it('gives an admin every site', async () => {
    expect(await access.accessibleSites(t.pool, { id: DEMO.admin, role: 'admin' })).toEqual(
      new Set([DEMO.siteA, DEMO.siteB]),
    );
  });

  it('gives a technician only their own user_sites rows', async () => {
    expect(await access.accessibleSites(t.pool, { id: DEMO.techA, role: 'technician' })).toEqual(new Set([DEMO.siteA]));
  });

  it('gives a technician without sites an empty set', async () => {
    await t.pool.query(`DELETE FROM user_sites WHERE user_id = $1`, [DEMO.techB]);
    expect(await access.accessibleSites(t.pool, { id: DEMO.techB, role: 'technician' })).toEqual(new Set());
  });
});
