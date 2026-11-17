import { MUTATORS, MUTATOR_NAMES, getMutator } from '../../src';
import { MapTx } from '../support/map-tx';
import { run } from '../support/mutate';

describe('mutator registry', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', ''])('has no mutator named "%s"', (name) => {
    expect(getMutator(name)).toBeUndefined();
  });

  it('registers exactly the protocol mutator names', () => {
    expect([...MUTATORS.keys()].sort()).toEqual([...MUTATOR_NAMES].sort());
  });

  it('is deterministic: same rows, args and ctx give identical rows', () => {
    const args = {
      id: '11111111-1111-4111-8111-111111111111',
      siteId: '33333333-3333-4333-8333-33333333333a',
      title: 'Pump',
      description: '',
    };
    const a = new MapTx();
    const b = new MapTx();
    run(a, 'ticket.create', args);
    run(b, 'ticket.create', args);
    expect([...a.rows]).toEqual([...b.rows]);
  });
});
