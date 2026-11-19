import { addPartArgs, createTicketArgs } from '@fieldsync/sync-core';
import { formErrors } from '@/shared/lib/form-errors';

const messages = (schema: { safeParse: (v: unknown, o: object) => unknown }, value: unknown) => {
  const result = schema.safeParse(value, { error: formErrors }) as {
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
  return Object.fromEntries((result.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));
};

describe('formErrors', () => {
  it('words the ticket rules plainly', () => {
    expect(
      messages(createTicketArgs.omit({ id: true }), { siteId: '', title: '   ', description: 'x'.repeat(5001) }),
    ).toEqual({ siteId: 'Choose one', title: 'Required', description: 'At most 5000 characters' });
  });

  it('words the part rules plainly', () => {
    const part = addPartArgs.pick({ name: true, quantity: true });
    expect(messages(part, { name: '', quantity: NaN })).toEqual({ name: 'Required', quantity: 'Enter a whole number' });
    expect(messages(part, { name: 'x'.repeat(101), quantity: 0 })).toEqual({
      name: 'At most 100 characters',
      quantity: 'At least 1',
    });
    expect(messages(part, { name: 'Filter', quantity: 1.5 })).toEqual({ quantity: 'Enter a whole number' });
    expect(messages(part, { name: 'Filter', quantity: 1001 })).toEqual({ quantity: 'At most 1000' });
  });
});
