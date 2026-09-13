'use client';

import { motion, useInView, useReducedMotion } from 'motion/react';
import { useRef } from 'react';

type Direction = 'up' | 'down' | 'left' | 'right' | 'none';

const OFFSETS: Record<Direction, { x: number; y: number }> = {
  up: { x: 0, y: 28 },
  down: { x: 0, y: -28 },
  left: { x: 28, y: 0 },
  right: { x: -28, y: 0 },
  none: { x: 0, y: 0 },
};

export interface RevealProps {
  children: React.ReactNode;
  className?: string;
  /** Seconds to wait before animating in. Use to stagger siblings. */
  delay?: number;
  direction?: Direction;
  /** Animate every time it scrolls into view rather than only the first time. */
  repeat?: boolean;
  as?: 'div' | 'section' | 'li' | 'span';
}

/**
 * Reveals children when they scroll into view.
 *
 * Respects `prefers-reduced-motion` by rendering the final state immediately —
 * content must never be withheld from someone who disabled animation.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  direction = 'up',
  repeat = false,
  as = 'div',
}: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: !repeat, margin: '-10% 0px -10% 0px' });
  const reduceMotion = useReducedMotion();

  const offset = OFFSETS[direction];

  // `motion[as]` is a union of component types whose `ref` props do not
  // intersect, so a single ref cannot satisfy all of them. Widening to
  // ElementType lets one ref serve every variant.
  const Component = motion[as] as React.ElementType;

  if (reduceMotion) {
    const Static = as;
    return <Static className={className}>{children}</Static>;
  }

  return (
    <Component
      ref={ref}
      className={className}
      initial={{ opacity: 0, x: offset.x, y: offset.y }}
      animate={inView ? { opacity: 1, x: 0, y: 0 } : undefined}
      transition={{
        duration: 0.7,
        delay,
        // A gentle overshoot-free ease that reads as "settled" rather than springy.
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      {children}
    </Component>
  );
}

/** Applies a uniform stagger to a list of `Reveal` children. */
export function RevealGroup({
  children,
  className,
  step = 0.08,
  direction = 'up',
}: {
  children: React.ReactNode[];
  className?: string;
  step?: number;
  direction?: Direction;
}) {
  return (
    <div className={className}>
      {children.map((child, i) => (
        <Reveal key={i} delay={i * step} direction={direction}>
          {child}
        </Reveal>
      ))}
    </div>
  );
}
