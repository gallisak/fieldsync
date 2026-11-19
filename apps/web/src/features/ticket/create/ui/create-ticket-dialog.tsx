'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { SiteSelect, type Site } from '@/entities/site';
import { formErrors } from '@/shared/lib/form-errors';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/shared/ui/form';
import { Input } from '@/shared/ui/input';
import { Textarea } from '@/shared/ui/textarea';
import { createTicketFields, useCreateTicket, type CreateTicketFields } from '../model/use-create-ticket';

export function CreateTicketDialog({ sites, defaultSiteId }: { sites: readonly Site[]; defaultSiteId?: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const create = useCreateTicket();
  const initialSite = sites.length === 1 ? sites[0].id : (defaultSiteId ?? '');
  const form = useForm<CreateTicketFields>({
    resolver: zodResolver(createTicketFields, { error: formErrors }),
    defaultValues: { title: '', description: '', siteId: initialSite },
  });

  const onSubmit = form.handleSubmit(async (fields) => {
    const created = create(fields);
    if (!created) return;
    setOpen(false);
    form.reset({ title: '', description: '', siteId: initialSite });
    if (await created.stored) router.push(`/tickets/${created.id}`);
  });

  if (sites.length === 0) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New ticket</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>Saved on this device at once, and sent to the server when online.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea rows={4} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {sites.length > 1 && (
              <FormField
                control={form.control}
                name="siteId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Site</FormLabel>
                    <FormControl>
                      <SiteSelect sites={sites} value={field.value || undefined} onChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="submit">Create</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
