import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

/**
 * eslint-config-next 16 ships flat config directly, so it is imported rather
 * than wrapped in FlatCompat — the compat layer cannot serialise the config
 * and fails with a circular-structure error.
 */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'drizzle/**',
      'public/**',
      'data/**',
      'next-env.d.ts',
      // The superseded Flutter scaffold, kept on disk but not part of this app.
      'autoloadmanagment_app/**',
    ],
  },

  ...coreWebVitals,
  ...typescript,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // Tenant isolation depends on feature code never holding a raw database
    // handle. This makes that structural rather than a convention people are
    // expected to remember.
    files: ['src/app/**', 'src/components/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/lib/db/client',
              message:
                'Never import the raw database handle. Use forOrg(orgId) from @/lib/db/scope, ' +
                'which welds the tenant predicate onto every query.',
            },
          ],
        },
      ],
    },
  },

  {
    // Scripts are operator tools that run outside a request, so they
    // legitimately reach the database directly and write to the console.
    files: ['scripts/**'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    /*
     * The two places that legitimately hold a raw handle, listed explicitly so
     * the set stays small and reviewable rather than growing by exception.
     *
     * - (auth)/actions.ts creates the organisation and its first user, so no
     *   tenant scope exists yet to scope by.
     * - api/vin/decode writes vin_decodes, which is public NHTSA data shared
     *   across every tenant and deliberately outside the scoped registry.
     */
    files: ['src/app/(auth)/actions.ts', 'src/app/api/vin/decode/route.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];

export default config;
