import { z } from 'zod';
import { MUTATOR_NAMES } from './types';

// Stored as text and logged: Postgres refuses NUL, and a log line must not be forged.
const clientId = z.string().regex(/^[\w.:-]{1,64}$/, 'must be 1-64 letters, digits, or . _ : -');

export const pushRequestSchema = z.object({
  clientId,
  mutations: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.enum(MUTATOR_NAMES),
        args: z.record(z.string(), z.unknown()),
      }),
    )
    .max(100),
});

export const pullQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  clientId: clientId.optional(),
  ackedMutationId: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

export type PullQuery = z.infer<typeof pullQuerySchema>;
