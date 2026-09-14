'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { AlertCircle, ArrowRight, Building2, Lock, Mail, User } from 'lucide-react';
import { registerAction, type ActionResult } from '../actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';

/**
 * Live password feedback.
 *
 * Length-first, per current NIST guidance. Composition rules push people
 * toward "Password1!" and are deliberately not enforced.
 */
function strengthOf(password: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (password.length === 0) return { score: 0, label: '' };
  if (password.length < 12) return { score: 1, label: 'Too short' };
  const variety =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password));
  if (password.length >= 20 || variety >= 3) return { score: 3, label: 'Strong' };
  return { score: 2, label: 'Good' };
}

export default function RegisterPage() {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    registerAction,
    null,
  );
  const [password, setPassword] = useState('');
  const strength = strengthOf(password);

  return (
    <div className="w-full max-w-md">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-ink">Set up your company</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          Creates your organisation and makes you its owner. Takes about a minute.
        </p>
      </div>

      <form
        action={formAction}
        className="ring-gradient mt-8 rounded-2xl border border-line bg-raised p-6 shadow-sm"
      >
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
            name="companyName"
            label="Company name"
            required
            autoFocus
            leading={<Building2 />}
            error={state?.fieldErrors?.companyName}
            placeholder="Ridgeline Auto Transport LLC"
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              name="usdotNumber"
              label="USDOT number"
              inputMode="numeric"
              hint="Optional"
              error={state?.fieldErrors?.usdotNumber}
              placeholder="1234567"
            />
            <Input
              name="mcNumber"
              label="MC number"
              hint="Optional"
              error={state?.fieldErrors?.mcNumber}
              placeholder="MC-987654"
            />
          </div>

          <hr className="border-line" />

          <Input
            name="displayName"
            label="Your name"
            required
            autoComplete="name"
            leading={<User />}
            error={state?.fieldErrors?.displayName}
          />

          <Input
            name="email"
            type="email"
            label="Email"
            required
            autoComplete="username"
            leading={<Mail />}
            error={state?.fieldErrors?.email}
            placeholder="you@carrier.com"
          />

          <div>
            <Input
              name="password"
              type="password"
              label="Password"
              required
              minLength={12}
              autoComplete="new-password"
              leading={<Lock />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={state?.fieldErrors?.password}
              hint="At least 12 characters. A passphrase beats a short complicated one."
            />

            {password.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <div className="flex flex-1 gap-1" aria-hidden>
                  {[1, 2, 3].map((step) => (
                    <span
                      key={step}
                      className={cn(
                        'h-1 flex-1 rounded-full transition-colors duration-300',
                        strength.score >= step
                          ? strength.score === 1
                            ? 'bg-danger'
                            : strength.score === 2
                              ? 'bg-warn'
                              : 'bg-ok'
                          : 'bg-sunken',
                      )}
                    />
                  ))}
                </div>
                <span
                  className={cn(
                    'w-16 text-right text-xs',
                    strength.score === 1 && 'text-danger',
                    strength.score === 2 && 'text-warn',
                    strength.score === 3 && 'text-ok',
                  )}
                >
                  {strength.label}
                </span>
              </div>
            )}
          </div>
        </div>

        <Button type="submit" size="lg" block className="group mt-6" loading={pending}>
          Create account
          <ArrowRight
            className="transition-transform duration-200 group-hover:translate-x-0.5"
            aria-hidden
          />
        </Button>

        <p className="mt-4 text-center text-xs leading-relaxed text-ink-muted">
          Everything you enter stays in this instance&rsquo;s own database.
        </p>
      </form>

      <p className="mt-6 text-center text-sm text-ink-secondary">
        Already set up?{' '}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
