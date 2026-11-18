import { z } from 'zod';

export const partSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  siteId: z.string(),
  name: z.string(),
  quantity: z.number(),
});

export type Part = z.infer<typeof partSchema>;
