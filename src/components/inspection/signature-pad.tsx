'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

/**
 * Signature capture.
 *
 * Records the stroke path with timing and pressure alongside the flattened
 * image. A pasted or traced signature reproduces the picture but not the
 * dynamics, so the stroke data is worth far more evidentially than the PNG —
 * which is the whole reason a rendered image plus a timestamp has been held
 * insufficient.
 */

export interface StrokePoint {
  x: number;
  y: number;
  /** Milliseconds since the first point of the first stroke. */
  t: number;
  /** 0 when the pointer reports no pressure, as a mouse does. */
  p: number;
}

export type Stroke = StrokePoint[];

export interface SignatureResult {
  dataUrl: string;
  strokes: Stroke[];
  /** Seconds spent signing. A sub-second "signature" is worth noticing. */
  durationMs: number;
}

export interface SignaturePadProps {
  onChange: (result: SignatureResult | null) => void;
  label?: string;
  className?: string;
}

export function SignaturePad({ onChange, label = 'Signature', className }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const [hasInk, setHasInk] = useState(false);

  /** Backing store is sized to the device pixel ratio so ink is not blurry. */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;

    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);

    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#111111';
    context.lineWidth = 2.2;
  }, []);

  useEffect(() => {
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [resize]);

  const emit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || strokesRef.current.length === 0) {
      onChange(null);
      return;
    }
    onChange({
      dataUrl: canvas.toDataURL('image/png'),
      strokes: strokesRef.current,
      durationMs: startedAtRef.current === null ? 0 : Math.round(performance.now() - startedAtRef.current),
    });
  }, [onChange]);

  const pointFrom = (event: React.PointerEvent<HTMLCanvasElement>): StrokePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    startedAtRef.current ??= performance.now();
    return {
      x: Math.round((event.clientX - rect.left) * 100) / 100,
      y: Math.round((event.clientY - rect.top) * 100) / 100,
      t: Math.round(performance.now() - (startedAtRef.current ?? 0)),
      p: Math.round(event.pressure * 100) / 100,
    };
  };

  const handleDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFrom(event);
    currentRef.current = [point];

    const context = canvasRef.current?.getContext('2d');
    context?.beginPath();
    context?.moveTo(point.x, point.y);
    setHasInk(true);
  };

  const handleMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!currentRef.current) return;

    const context = canvasRef.current?.getContext('2d');
    if (!context) return;

    // Coalesced events give the full path on a high-rate stylus rather than
    // one sample per frame, which is most of what makes the capture look and
    // measure like a real signature.
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];

    for (const raw of events) {
      const rect = event.currentTarget.getBoundingClientRect();
      const point: StrokePoint = {
        x: Math.round((raw.clientX - rect.left) * 100) / 100,
        y: Math.round((raw.clientY - rect.top) * 100) / 100,
        t: Math.round(performance.now() - (startedAtRef.current ?? 0)),
        p: Math.round((raw.pressure ?? 0) * 100) / 100,
      };
      currentRef.current.push(point);
      context.lineTo(point.x, point.y);
    }

    context.stroke();
  };

  const handleUp = () => {
    if (currentRef.current && currentRef.current.length > 0) {
      strokesRef.current.push(currentRef.current);
    }
    currentRef.current = null;
    emit();
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas && context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    strokesRef.current = [];
    currentRef.current = null;
    startedAtRef.current = null;
    setHasInk(false);
    onChange(null);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">{label}</span>
        {hasInk && (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            <Eraser aria-hidden />
            Clear
          </Button>
        )}
      </div>

      <div className="relative overflow-hidden rounded-xl border border-line bg-white">
        <canvas
          ref={canvasRef}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerLeave={handleUp}
          onPointerCancel={handleUp}
          // Without this the browser scrolls the page instead of drawing.
          className="h-40 w-full touch-none"
        />

        {!hasInk && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-neutral-400">
            Sign here
          </span>
        )}

        <span className="pointer-events-none absolute inset-x-6 bottom-6 border-b border-neutral-300" />
      </div>
    </div>
  );
}
