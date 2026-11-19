'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { formErrors } from '@/shared/lib/form-errors';
import { Button } from '@/shared/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/shared/ui/form';
import { Input } from '@/shared/ui/input';
import { partFields, useAddPart, type PartFields } from '../model/use-add-part';

const EMPTY: PartFields = { name: '', quantity: 1 };

export function AddPartForm({ ticketId }: { ticketId: string }) {
  const add = useAddPart(ticketId);
  const form = useForm<PartFields>({
    resolver: zodResolver(partFields, { error: formErrors }),
    defaultValues: EMPTY,
  });

  const onSubmit = form.handleSubmit((fields) => {
    if (add(fields)) form.reset(EMPTY);
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="flex flex-wrap items-start gap-2">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem className="min-w-48 flex-1">
              <FormLabel className="sr-only">Part name</FormLabel>
              <FormControl>
                <Input placeholder="Part name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="quantity"
          render={({ field }) => (
            <FormItem className="w-24">
              <FormLabel className="sr-only">Quantity</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  {...field}
                  value={Number.isNaN(field.value) ? '' : field.value}
                  onChange={(e) => field.onChange(e.target.valueAsNumber)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">Add part</Button>
      </form>
    </Form>
  );
}
