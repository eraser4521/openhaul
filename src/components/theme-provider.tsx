'use client';

import { ThemeProvider as NextThemeProvider } from 'next-themes';

/**
 * `nonce` is not optional in practice — see the root layout.
 *
 * next-themes writes an inline <script> that sets the theme class before the
 * first paint. Next stamps its own inline scripts with the CSP nonce but knows
 * nothing about this one, so without it the browser blocks the script and the
 * page paints in the default theme until React hydrates and corrects it — a
 * white flash on every navigation for anyone using the light theme.
 */
export function ThemeProvider({
  children,
  nonce,
}: {
  children: React.ReactNode;
  nonce?: string;
}) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemeProvider>
  );
}
