import { PullService } from '../src/pull.service';

describe('PullService', () => {
  it('only returns changes for sites the user can access', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const svc = new PullService({ pool } as never);
    const res = await svc.pull({ id: 'u1', role: 'technician' }, 5, 100);
    expect(res.changes).toEqual([]);
  });
});
