import type { z } from 'zod';

export const formErrors: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string')
        return Number(issue.minimum) <= 1 ? 'Required' : `At least ${issue.minimum} characters`;
      if (issue.origin === 'number') return `At least ${issue.minimum}`;
      return undefined;
    case 'too_big':
      if (issue.origin === 'string') return `At most ${issue.maximum} characters`;
      if (issue.origin === 'number') return `At most ${issue.maximum}`;
      return undefined;
    case 'invalid_type':
      return issue.expected === 'number' || issue.expected === 'int' ? 'Enter a whole number' : undefined;
    case 'invalid_format':
      return issue.format === 'uuid' ? 'Choose one' : undefined;
    default:
      return undefined;
  }
};
