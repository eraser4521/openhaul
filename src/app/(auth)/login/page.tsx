'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { AlertCircle, ArrowRight, Lock, Mail } from 'lucide-react';
import { loginAction, type ActionResult } from '../actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function LoginPage() {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    loginAction,
    null,
  );

  return (
    <div className="w-full max-w-sm">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-ink">Sign in</h1>
        <p className="mt-2 text-sm text-ink-secondary">Pick up where your fleet left off.</p>
      </div>

      <form action={formAction} className="ring-gradient mt-8 rounded-2xl border border-line bg-raised p-6 shadow-sm">
        {state?.error && (
          <p
            role="alert"
            className="mb-5 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {state.error}
          </p>
        )}

        <div className="flex flex-col gap-4">
          <Input
            name="email"
            type="email"
            label="Email"
            autoComplete="username"
            required
            autoFocus
            leading={<Mail />}
            error={state?.fieldErrors?.email}
            placeholder="you@carrier.com"
          />

          <Input
            name="password"
            type="password"
            label="Password"
            autoComplete="current-password"
            required
            leading={<Lock />}
            error={state?.fieldErrors?.password}
          />
        </div>

        <Button type="submit" size="lg" block className="group mt-6" loading={pending}>
          Sign in
          <ArrowRight
            className="transition-transform duration-200 group-hover:translate-x-0.5"
            aria-hidden
          />
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-secondary">
        First time here?{' '}
        <Link href="/register" className="font-medium text-brand hover:underline">
          Set up your company
        </Link>
      </p>
    </div>
  );
}
