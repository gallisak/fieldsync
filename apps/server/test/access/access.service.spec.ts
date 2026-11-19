import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { AdminGuard } from '../../src/access/access.admin.controller';
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

describe('AccessService.accessibleSites', () => {
  const access = new AccessService();
  const db = {
    async query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }> {
      if (text.includes('FROM sites')) return { rows: [{ id: A }, { id: B }, { id: C }] as R[] };
      return { rows: (values?.[0] === TECH.id ? [{ site_id: A }] : []) as R[] };
    },
  };

  it('gives an admin every site and a technician only the granted ones', async () => {
    expect(await access.accessibleSites(db, ADMIN)).toEqual(new Set([A, B, C]));
    expect(await access.accessibleSites(db, TECH)).toEqual(new Set([A]));
    expect(await access.accessibleSites(db, { id: 'nobody', role: 'technician' })).toEqual(new Set());
  });
});

describe('AdminGuard', () => {
  const as = (user: AuthUser) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

  it('lets only an admin change access', () => {
    expect(new AdminGuard().canActivate(as(ADMIN))).toBe(true);
    expect(() => new AdminGuard().canActivate(as(TECH))).toThrow(ForbiddenException);
  });
});
