'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Camera, Check, Images, Loader2, Trash2 } from 'lucide-react';
import { INSPECTION_SEQUENCE } from '@/lib/aiag/codes';
import type { LocalPhoto } from '@/lib/offline/db';
import { cn } from '@/lib/utils/cn';

/**
 * The guided walk-around.
 *
 * Slots follow the order the standard prescribes — rear, each side back to
 * front, front, then interior — so a driver who works top to bottom produces a
 * complete set without having to remember the sequence.
 */

export interface PhotoSlotsProps {
  photos: LocalPhoto[];
  busySlot: string | null;
  onCapture: (slot: string, file: File) => void;
  onRemove: (photoId: string) => void;
  disabled?: boolean;
}

/**
 * Renders a locally-held photo.
 *
 * The object URL is created during render and revoked on cleanup. Creating it
 * in an effect and storing it in state would render one empty frame first and
 * cascade an extra render per thumbnail, which is visible across a grid of
 * twelve.
 *
 * next/image is deliberately not used: there is no remote loader to optimise a
 * blob URL, and the bytes are already resized on the device.
 */
function Thumbnail({ blob, alt }: { blob: Blob; alt: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className="size-full object-cover" />;
}

export function PhotoSlots({
  photos,
  busySlot,
  onCapture,
  onRemove,
  disabled,
}: PhotoSlotsProps) {
  const cameraInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const galleryInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const bySlot = useMemo(() => {
    const map = new Map<string, LocalPhoto>();
    for (const photo of photos) {
      if (photo.slot) map.set(photo.slot, photo);
    }
    return map;
  }, [photos]);

  const captured = bySlot.size;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Walk-around</h2>
        <span className="text-xs text-ink-secondary tabular-nums">
          {captured} of {INSPECTION_SEQUENCE.length}
        </span>
      </div>

      <div className="mb-3 h-1 overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-500"
          style={{ width: `${(captured / INSPECTION_SEQUENCE.length) * 100}%` }}
        />
      </div>

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {INSPECTION_SEQUENCE.map((step) => {
          const photo = bySlot.get(step.slot);
          const busy = busySlot === step.slot;

          return (
            <li key={step.slot}>
              <div
                className={cn(
                  'group relative aspect-[4/3] overflow-hidden rounded-xl border transition-colors',
                  photo ? 'border-ok/40' : 'border-dashed border-line hover:border-line-strong',
                )}
              >
                {photo ? (
                  <>
                    <Thumbnail blob={photo.thumbnail} alt={step.label} />
                    <span className="absolute top-1.5 left-1.5 grid size-5 place-items-center rounded-full bg-ok text-white">
                      <Check className="size-3" aria-hidden />
                    </span>
                    {!disabled && (
                      <button
                        type="button"
                        onClick={() => onRemove(photo.id)}
                        aria-label={`Remove the ${step.label} photo`}
                        className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Trash2 className="size-3" aria-hidden />
                      </button>
                    )}
                  </>
                ) : busy ? (
                  <span className="grid size-full place-items-center">
                    <Loader2 className="size-5 animate-spin text-brand" aria-hidden />
                  </span>
                ) : (
                  <div className="flex size-full flex-col items-center justify-center gap-1.5 p-2 text-center">
                    <span className="flex gap-1">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => cameraInputs.current[step.slot]?.click()}
                        aria-label={`Photograph the ${step.label}`}
                        className="grid size-9 place-items-center rounded-lg bg-sunken text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
                      >
                        <Camera className="size-4" aria-hidden />
                      </button>
                      {/*
                        Choosing from the gallery is the single most repeated
                        request against the paid driver apps, which force the
                        camera and nothing else.
                      */}
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => galleryInputs.current[step.slot]?.click()}
                        aria-label={`Choose an existing photo for the ${step.label}`}
                        className="grid size-9 place-items-center rounded-lg bg-sunken text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
                      >
                        <Images className="size-4" aria-hidden />
                      </button>
                    </span>
                  </div>
                )}

                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pt-4 pb-1.5">
                  <span className="block text-[0.6875rem] font-medium text-white">{step.label}</span>
                </span>
              </div>

              {!photo && !busy && (
                <p className="mt-1 px-0.5 text-[0.6875rem] leading-snug text-ink-muted">
                  {step.hint}
                </p>
              )}

              <input
                ref={(el) => {
                  cameraInputs.current[step.slot] = el;
                }}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onCapture(step.slot, file);
                  e.target.value = '';
                }}
              />
              <input
                ref={(el) => {
                  galleryInputs.current[step.slot] = el;
                }}
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onCapture(step.slot, file);
                  e.target.value = '';
                }}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
