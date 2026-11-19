import { localTarget } from '@/app/providers/local-target';

const ORIGIN = 'http://localhost:3000';

describe('localTarget', () => {
  it.each([
    ['/tickets/1?x=1#y', '/tickets/1?x=1#y'],
    ['/', '/'],
    [null, '/'],
    ['https://evil.example/phish', '/'],
    ['//evil.example/phish', '/'],
    ['/\\evil.example/phish', '/'],
    ['/\t/evil.example/phish', '/'],
    ['/..//evil.example/phish', '/'],
    ['/.//evil.example/phish', '/'],
    ['/%2e%2e//evil.example/phish', '/'],
    ['/sign-in', '/'],
  ])('sends %p to %p', (next, expected) => {
    expect(localTarget(next, ORIGIN)).toBe(expected);
  });
});
