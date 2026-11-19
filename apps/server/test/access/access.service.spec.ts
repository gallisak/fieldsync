import { AccessService } from '../../src/access/access.service';
import type { AuthUser } from '../../src/auth/auth.guard';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const C = '00000000-0000-4000-8000-0000000000c1';
const ADMIN: AuthUser = { id: 'admin', role: 'admin' };
const TECH: AuthUser = { id: 'tech', role: 'technician' };

describe('AccessService.fingerprint', () => {
  const access = new AccessService();

  it('is stable under order and changes with a site, the role or the database epoch', () => {
    const fp = access.fingerprint(TECH, [A, B], 'epoch-1');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(access.fingerprint(TECH, [B, A], 'epoch-1')).toBe(fp);
    expect(access.fingerprint(TECH, [A, B, C], 'epoch-1')).not.toBe(fp);
    expect(access.fingerprint(TECH, [A], 'epoch-1')).not.toBe(fp);
    expect(access.fingerprint(ADMIN, [A, B], 'epoch-1')).not.toBe(fp);
    expect(access.fingerprint(TECH, [A, B], 'epoch-2')).not.toBe(fp);
  });
});
