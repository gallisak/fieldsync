import { z } from 'zod';

export const ticketStatus = z.enum(['open', 'in_progress', 'done', 'cancelled']);

// Lowercase only: Postgres stores uuid lowercased, so an uppercase id would name one row twice. Nil and max are out.
const id = z.uuid({ abort: true }).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'must be lowercase');

// jsonb refuses NUL and unpaired surrogates, so such text would be applied here and then fail on the server.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const storable = (s: z.ZodString) =>
  s.refine((v) => !v.includes('\u0000') && !LONE_SURROGATE.test(v), 'contains characters that cannot be stored');
const title = storable(z.string().trim().min(1).max(200));
const description = storable(z.string().max(5000));

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
  name: storable(z.string().trim().min(1).max(100)),
  quantity: z.number().int().min(1).max(1000),
});

export const adjustPartArgs = z.object({ id, delta: z.number().int().min(-1000).max(1000) });
