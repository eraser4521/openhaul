import Link from 'next/link';
import { GithubIcon } from '@/components/ui/icons';
import { Logo } from '@/components/ui/logo';
import { LICENSE, REPO_URL } from '@/lib/constants';

const SECTIONS = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '#features' },
      { label: 'How it works', href: '#workflow' },
      { label: 'Security', href: '#security' },
      { label: 'Pricing', href: '#pricing' },
    ],
  },
  {
    title: 'Documentation',
    links: [
      { label: 'Self-hosting guide', href: `${REPO_URL}/blob/main/docs/SELF_HOSTING.md` },
      { label: 'Architecture', href: `${REPO_URL}/blob/main/docs/ARCHITECTURE.md` },
      { label: 'Data model', href: `${REPO_URL}/blob/main/docs/DATA_MODEL.md` },
      { label: 'Security policy', href: `${REPO_URL}/blob/main/SECURITY.md` },
    ],
  },
  {
    title: 'Project',
    links: [
      { label: 'Source code', href: REPO_URL },
      { label: 'Report an issue', href: `${REPO_URL}/issues` },
      { label: 'Contributing', href: `${REPO_URL}/blob/main/CONTRIBUTING.md` },
      { label: 'Licence', href: `${REPO_URL}/blob/main/LICENSE` },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-sunken/40">
      <div className="mx-auto max-w-6xl px-5 py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-secondary">
              Load management for car haulers that you host, own and can walk away with.
            </p>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-5 inline-flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-xs font-medium text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
            >
              <GithubIcon className="size-4" aria-hidden />
              Star on GitHub
            </a>
          </div>

          {SECTIONS.map((section) => (
            <nav key={section.title} aria-label={section.title}>
              <h2 className="text-xs font-semibold tracking-wide text-ink uppercase">
                {section.title}
              </h2>
              <ul className="mt-4 space-y-2.5">
                {section.links.map((link) => (
                  <li key={link.label}>
                    {link.href.startsWith('#') ? (
                      <a
                        href={link.href}
                        className="text-sm text-ink-secondary transition-colors hover:text-ink"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-sm text-ink-secondary transition-colors hover:text-ink"
                      >
                        {link.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-muted">
            Licensed under {LICENSE}. Run it, change it, keep your data.
          </p>
          <p className="max-w-xl text-xs leading-relaxed text-ink-muted">
            OpenHaul is not legal advice. Regulatory references are provided so you can verify them
            with your own counsel.
          </p>
        </div>
      </div>
    </footer>
  );
}

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-line py-24 sm:py-28">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(ellipse 60% 70% at 50% 100%, color-mix(in oklch, var(--brand) 18%, transparent), transparent 70%)',
        }}
        aria-hidden
      />
      <div className="relative mx-auto max-w-2xl px-5 text-center">
        <h2 className="text-3xl font-semibold text-ink sm:text-4xl">
          Stop renting your own paperwork
        </h2>
        <p className="mt-4 text-base leading-relaxed text-ink-secondary">
          Create an account on a local instance in about two minutes, or read the self-hosting guide
          and put it on your own server today.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/register"
            className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-brand px-6 text-[0.9375rem] font-medium text-brand-contrast shadow-sm transition-all hover:bg-brand-hover hover:shadow-glow active:scale-[0.97] sm:w-auto"
          >
            Create an account
          </Link>
          <a
            href={`${REPO_URL}/blob/main/docs/SELF_HOSTING.md`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-line bg-raised px-6 text-[0.9375rem] font-medium text-ink shadow-xs transition-all hover:border-line-strong hover:bg-sunken active:scale-[0.97] sm:w-auto"
          >
            Self-hosting guide
          </a>
        </div>
      </div>
    </section>
  );
}
