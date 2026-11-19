import { ticketStatus } from '@fieldsync/sync-core';
import { z } from 'zod';

export const ticketSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  title: z.string(),
  description: z.string(),
  status: ticketStatus,
  assigneeId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Ticket = z.infer<typeof ticketSchema>;
