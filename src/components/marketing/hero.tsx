'use client';

import Link from 'next/link';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowRight, Server, Sparkles } from 'lucide-react';
import { GithubIcon } from '@/components/ui/icons';
import { Aurora } from './aurora';
import { AppPreview } from './app-preview';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { REPO_URL } from '@/lib/constants';

const EASE = [0.16, 1, 0.3, 1] as const;

export function Hero() {
  const reduceMotion = useReducedMotion();

  // Hero content animates on load rather than on scroll, so it uses `animate`
  // directly instead of the scroll-driven Reveal component.
  const rise = (delay: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 24 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.8, delay, ease: EASE },
        };

  return (
    <section className="relative isolate overflow-hidden pt-32 pb-16 sm:pt-40 sm:pb-24">
      <Aurora />

      <div className="relative mx-auto max-w-6xl px-5">
        <div className="mx-auto max-w-3xl text-center">
          <motion.div {...rise(0)}>
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-raised/70 px-3 py-1.5 text-xs font-medium text-ink-secondary backdrop-blur">
              <Sparkles className="size-3.5 text-brand" aria-hidden />
              Free and open source · AGPL-3.0
            </span>
          </motion.div>

          <motion.h1
            {...rise(0.08)}
            className="mt-6 text-[2.5rem] leading-[1.05] font-semibold sm:text-6xl lg:text-[4.25rem]"
          >
            <span className="text-ink">Run your car hauling on</span>{' '}
            <span className="text-brand-gradient">software you own</span>
          </motion.h1>

          <motion.p
            {...rise(0.16)}
            className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-ink-secondary sm:text-lg"
          >
            Scan VINs with your phone camera, build legally-sound electronic BOLs, prove vehicle
            condition with timestamped photos, and invoice the broker — all from one app that runs
            on your own server. No per-truck fees. No one holding your data hostage.
          </motion.p>

          <motion.div
            {...rise(0.24)}
            className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <Link
              href="/register"
              className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'group w-full sm:w-auto')}
            >
              Start free
              <ArrowRight
                className="transition-transform duration-200 group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>

            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'w-full sm:w-auto')}
            >
              <GithubIcon />
              View source
            </a>
          </motion.div>

          <motion.p
            {...rise(0.3)}
            className="mt-5 flex items-center justify-center gap-1.5 text-xs text-ink-muted"
          >
            <Server className="size-3.5" aria-hidden />
            Self-host in one command, or run it locally on a laptop
          </motion.p>
        </div>

        {/* Product visual. Slight perspective tilt that settles flat, which
            reads as "the interface arriving" rather than a static image. */}
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 56, rotateX: 9, scale: 0.96 }}
          animate={reduceMotion ? undefined : { opacity: 1, y: 0, rotateX: 0, scale: 1 }}
          transition={{ duration: 1.1, delay: 0.36, ease: EASE }}
          className="mt-16 [perspective:1600px] sm:mt-20"
        >
          <AppPreview className="mx-auto max-w-5xl" />
        </motion.div>
      </div>
    </section>
  );
}
