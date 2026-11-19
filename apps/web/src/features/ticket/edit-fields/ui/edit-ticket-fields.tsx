'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import type { Ticket } from '@/entities/ticket';
import { formErrors } from '@/shared/lib/form-errors';
import { Button } from '@/shared/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/shared/ui/form';
import { Input } from '@/shared/ui/input';
import { Textarea } from '@/shared/ui/textarea';
import { ticketFields, useEditTicket, type TicketFields } from '../model/use-edit-ticket';

const FIELDS = ['title', 'description'] as const;

export function EditTicketFields({ ticket }: { ticket: Ticket }) {
  const save = useEditTicket(ticket.id);
  const { title, description } = ticket;
  const form = useForm<TicketFields>({
    resolver: zodResolver(ticketFields, { error: formErrors }),
    defaultValues: { title, description },
  });
  const { dirtyFields } = form.formState;
  const seen = useRef<TicketFields>({ title, description });

  useEffect(() => {
    form.reset({ title, description }, { keepDirtyValues: true });
    const current = { title, description };
    for (const f of FIELDS) if (!form.getFieldState(f).isDirty) seen.current[f] = current[f];
  }, [title, description, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    const patch: Partial<TicketFields> = {};
    for (const f of FIELDS) if (dirtyFields[f]) patch[f] = values[f];
    const stored = Object.keys(patch).length > 0 ? save(patch) : null;
    if (!stored) return;
    const before = { ...seen.current };
    seen.current = values;
    form.reset(values);
    if (await stored) return;
    // Not kept on this device: the edit is back to unsaved, so the user can try again.
    seen.current = before;
    form.reset(before);
    for (const f of Object.keys(patch) as (keyof TicketFields)[]) form.setValue(f, values[f], { shouldDirty: true });
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-4">
        {FIELDS.map((f) => (
          <FormField
            key={f}
            control={form.control}
            name={f}
            render={({ field }) => (
              <FormItem>
                <FormLabel className="capitalize">{f}</FormLabel>
                <FormControl>{f === 'title' ? <Input {...field} /> : <Textarea rows={4} {...field} />}</FormControl>
                {dirtyFields[f] && ticket[f] !== seen.current[f] && (
                  <FormDescription>
                    Changed by someone else while you were editing. Saving will overwrite it.
                  </FormDescription>
                )}
                <FormMessage />
              </FormItem>
            )}
          />
        ))}
        <Button type="submit" disabled={!form.formState.isDirty}>
          Save
        </Button>
      </form>
    </Form>
  );
}
