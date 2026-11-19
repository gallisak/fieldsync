import { readSession, signIn, signOut, type Session } from '@/entities/session/model/session-store';

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

  it('signs out', () => {
    signIn(session);
    signOut();
    expect(readSession()).toBeNull();
    expect(store.has('fs_session')).toBe(false);
  });
});
