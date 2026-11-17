import { z } from 'zod';

export const ticketStatus = z.enum(['open', 'in_progress', 'done', 'cancelled']);

const id = z.uuid();
const title = z.string().trim().min(1).max(200);
const description = z.string().max(5000);

export const createTicketArgs = z.object({ id, siteId: id, title, description });

export const updateTicketArgs = z.object({
  id,
  patch: z
    .strictObject({ title: title.optional(), description: description.optional(), assigneeId: id.nullable().optional() })
    .refine((p) => Object.values(p).some((v) => v !== undefined), 'patch must change at least one field'),
});

export const setStatusArgs = z.object({ id, from: ticketStatus, to: ticketStatus });

export const deleteTicketArgs = z.object({ id });

export const moveTicketArgs = z.object({ id, toSiteId: id });

export const addPartArgs = z.object({
  id,
  ticketId: id,
  name: z.string().trim().min(1).max(100),
  quantity: z.number().int().min(1).max(1000),
});

export const adjustPartArgs = z.object({ id, delta: z.number().int().min(-1000).max(1000) });
