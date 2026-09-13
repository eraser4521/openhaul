import { SiteHeader } from '@/components/marketing/site-header';
import { Hero } from '@/components/marketing/hero';
import { Features } from '@/components/marketing/features';
import { Workflow } from '@/components/marketing/workflow';
import { Security } from '@/components/marketing/security';
import { Pricing } from '@/components/marketing/pricing';
import { FinalCta, SiteFooter } from '@/components/marketing/site-footer';

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero />
        <Features />
        <Workflow />
        <Security />
        <Pricing />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
