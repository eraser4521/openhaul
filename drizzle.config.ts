import type { Config } from 'drizzle-kit';

export default {
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./data/openhaul.db',
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
  // Migrations are generated at development time and committed. Never run
  // `drizzle-kit push` against a real deployment: it diffs live schema and
  // can silently drop columns.
  strict: true,
  verbose: true,
} satisfies Config;
