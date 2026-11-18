import { PROTOCOL, PROTOCOL_HEADER, TransportError } from '@fieldsync/sync-core';
import { z } from 'zod';
import { API_URL } from '@/shared/config';

const TIMEOUT_MS = 20_000;

const meSchema = z.object({
  id: z.string(),
  role: z.enum(['admin', 'technician']),
  sites: z.array(z.object({ id: z.string(), name: z.string() })),
});

export type Me = z.infer<typeof meSchema>;

export async function fetchMe(token: string): Promise<Me> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${API_URL}/me`, {
        headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(PROTOCOL) },
        signal: controller.signal,
      });
    } catch (err) {
      const kind = controller.signal.aborted ? 'timeout' : 'network';
      throw new TransportError(kind, undefined, undefined, undefined, undefined, { cause: err });
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { code?: unknown; message?: unknown } | undefined;
      throw new TransportError(
        'http',
        res.status,
        typeof body?.code === 'string' ? body.code : undefined,
        undefined,
        typeof body?.message === 'string' ? body.message : undefined,
      );
    }
    return meSchema.parse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}
