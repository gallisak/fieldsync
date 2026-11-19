import {
  StorageUnavailableError,
  readSession,
  signIn,
  signOut,
  updateAccess,
  type Session,
} from '@/entities/session/model/session-store';

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const session: Session = {
  token: 'tech-a-token',
  userId: '00000000-0000-4000-8000-000000000002',
  role: 'technician',
  sites: [{ id: '00000000-0000-4000-8000-0000000000a1', name: 'North yard' }],
};

describe('session store', () => {
  beforeEach(() => store.clear());

  it('is signed out without a stored session', () => {
    expect(readSession()).toBeNull();
  });

  it('reads back a signed-in session, as the same object while it is unchanged', () => {
    signIn(session);
    const first = readSession();
    expect(first).toEqual(session);
    expect(readSession()).toBe(first);
  });

  it('treats unreadable or incomplete stored data as signed out', () => {
    store.set('fs_session', '{not json');
    expect(readSession()).toBeNull();
    store.set('fs_session', JSON.stringify({ ...session, role: 'owner' }));
    expect(readSession()).toBeNull();
    store.set('fs_session', JSON.stringify({ token: 'x' }));
    expect(readSession()).toBeNull();
  });

  describe('updateAccess', () => {
    const south = { id: '00000000-0000-4000-8000-0000000000b1', name: 'South plant' };
    const me = { id: session.userId, role: session.role, sites: session.sites };

    it('takes a site granted or revoked since sign-in', () => {
      signIn(session);
      updateAccess(session.token, { ...me, sites: [...session.sites, south] });
      expect(readSession()?.sites).toEqual([...session.sites, south]);
      updateAccess(session.token, { ...me, sites: [south] });
      expect(readSession()).toEqual({ ...session, sites: [south] });
    });

    it('keeps the same session object when nothing changed', () => {
      signIn(session);
      const before = readSession();
      updateAccess(session.token, me);
      expect(readSession()).toBe(before);
    });

    it('ignores an answer for another token or user, or after sign-out', () => {
      signIn(session);
      updateAccess('other-token', { ...me, sites: [] });
      updateAccess(session.token, { ...me, id: 'someone-else', sites: [] });
      expect(readSession()?.sites).toEqual(session.sites);
      signOut();
      updateAccess(session.token, me);
      expect(readSession()).toBeNull();
    });
  });

  it('reads as signed out when the browser blocks site data, and says so on sign-in', () => {
    const blocked = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    const real = globalThis.localStorage;
    Object.assign(globalThis, { localStorage: { getItem: blocked, setItem: blocked, removeItem: blocked } });
    try {
      expect(readSession()).toBeNull();
      expect(() => signIn(session)).toThrow(StorageUnavailableError);
      expect(() => signOut()).not.toThrow();
    } finally {
      Object.assign(globalThis, { localStorage: real });
    }
  });

  it('signs out', () => {
    signIn(session);
    signOut();
    expect(readSession()).toBeNull();
    expect(store.has('fs_session')).toBe(false);
  });
});
