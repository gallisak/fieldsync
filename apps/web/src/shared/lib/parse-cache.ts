import type { z } from 'zod';

// Keyed by the row object: the sync client keeps unchanged rows as the same objects across views.
export function cachedParser<S extends z.ZodType>(schema: S): (row: unknown) => z.infer<S> | null {
  const cache = new WeakMap<object, z.infer<S> | null>();
  return (row) => {
    if (typeof row !== 'object' || row === null) return null;
    if (cache.has(row)) return cache.get(row) as z.infer<S> | null;
    const parsed = schema.safeParse(row);
    const value = parsed.success ? parsed.data : null;
    cache.set(row, value);
    return value;
  };
}
