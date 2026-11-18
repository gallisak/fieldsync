import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';

export interface RequestContext {
  requestId: string;
  userId?: string;
  clientId?: string;
  mutationId?: number;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// The id goes into every log line, so a caller's value is taken only when it is a plain token.
const CALLER_ID = /^[\w.:-]{1,64}$/;

export function requestIdOf(req: IncomingMessage & { id?: unknown }): string {
  if (typeof req.id === 'string') return req.id;
  const header = req.headers['x-request-id'];
  req.id = typeof header === 'string' && CALLER_ID.test(header) ? header : randomUUID();
  return req.id as string;
}

export function withContext<T>(fields: Omit<RequestContext, 'requestId'>, fn: () => T): T {
  const current = requestContext.getStore();
  return current ? requestContext.run({ ...current, ...fields }, fn) : fn();
}
