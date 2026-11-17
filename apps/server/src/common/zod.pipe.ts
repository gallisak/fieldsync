import { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiError } from './errors';

export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw new ApiError('BAD_REQUEST', 400, issues, 'Malformed request');
    }
    return result.data;
  }
}
