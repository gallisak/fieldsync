'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/shared/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/shared/ui/form';
import { Input } from '@/shared/ui/input';
import { signInByToken } from '../model/sign-in-by-token';

const schema = z.object({ token: z.string().trim().min(1, 'Enter your access token') });
type Values = z.infer<typeof schema>;

export function SignInForm() {
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { token: '' } });

  const onSubmit = form.handleSubmit(async ({ token }) => {
    const error = await signInByToken(token);
    if (error) form.setError('token', { message: error });
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-4">
        <FormField
          control={form.control}
          name="token"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Access token</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="off" autoFocus {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>
    </Form>
  );
}
