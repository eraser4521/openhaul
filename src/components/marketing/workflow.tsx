import { Reveal } from '@/components/ui/reveal';

const STEPS = [
  {
    n: '01',
    title: 'Book the load',
    body:
      'Enter the order or paste it from a broker sheet. Each vehicle gets a VIN, and NHTSA fills in year, make, model and body class automatically.',
  },
  {
    n: '02',
    title: 'Dispatch to a driver',
    body:
      'Assign the run, sequence the stops, and check the deck fits before anyone rolls. The driver gets it on their phone.',
  },
  {
    n: '03',
    title: 'Inspect at pickup',
    body:
      'Scan each VIN, walk the guided photo set, mark damage on the diagram, and capture the shipper signature. Works with no signal.',
  },
  {
    n: '04',
    title: 'Haul it',
    body:
      'Status updates and ETAs stay current for whoever is asking. Documents stay attached to the load, not a text thread.',
  },
  {
    n: '05',
    title: 'Deliver and sign',
    body:
      'Second inspection, consignee signature, and the BOL is sealed — the exact rendered bytes are hashed and stored, not regenerated later.',
  },
  {
    n: '06',
    title: 'Invoice and get paid',
    body:
      'Generate the invoice from the load, attach the signed BOL and condition reports, and send it the same day.',
  },
];

export function Workflow() {
  return (
    <section id="workflow" className="relative scroll-mt-20 border-y border-line bg-sunken/40 py-24 sm:py-32">
      <div className="bg-dots mask-fade absolute inset-0 opacity-40" aria-hidden />

      <div className="relative mx-auto max-w-6xl px-5">
        <Reveal className="mx-auto max-w-2xl text-center">
          <div>
            <p className="text-sm font-medium text-brand">How it works</p>
            <h2 className="mt-3 text-3xl font-semibold text-ink sm:text-4xl">
              One load, start to finish
            </h2>
            <p className="mt-4 text-base leading-relaxed text-ink-secondary">
              Every step writes to the same record, so nothing is retyped and nothing goes missing
              between the yard and the invoice.
            </p>
          </div>
        </Reveal>

        <ol className="mt-14 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((step, i) => (
            <Reveal key={step.n} delay={i * 0.07} as="li" className="bg-base">
              <div className="group relative h-full p-6 transition-colors duration-300 hover:bg-raised">
                <span className="font-mono text-xs font-medium text-brand tabular-nums">
                  {step.n}
                </span>
                <h3 className="mt-3 text-base font-semibold text-ink">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{step.body}</p>

                {/* Brand rule that draws in on hover. */}
                <span
                  className="absolute inset-x-6 bottom-0 h-px origin-left scale-x-0 bg-brand transition-transform duration-500 group-hover:scale-x-100"
                  aria-hidden
                />
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}
