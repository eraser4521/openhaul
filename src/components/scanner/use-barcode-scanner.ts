'use client';

import { useEffect, useRef, useState } from 'react';
import { BarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill';
import { classifyVin, isValidVin, normalizeVin } from '@/lib/vin';

/**
 * Barcode decode loop over a live video element.
 *
 * Uses the `barcode-detector` ponyfill: it implements the W3C BarcodeDetector
 * interface, backed by the native implementation where one exists and by
 * ZXing compiled to WebAssembly everywhere else. That matters because Safari
 * ships no BarcodeDetector, and every iOS browser is WKWebView — so on iPhone
 * there is no native path at all.
 */

/**
 * Point the decoder at our own copy of the WASM rather than a CDN, so
 * scanning works with no signal. This is the whole reason the binary is
 * committed under public/wasm.
 */
let modulePrepared = false;
function prepareOnce() {
  if (modulePrepared) return;
  modulePrepared = true;
  prepareZXingModule({
    overrides: {
      locateFile: (file: string, prefix: string) =>
        file.endsWith('.wasm') ? `/wasm/${file}` : `${prefix}${file}`,
    },
  });
}

/**
 * Only the symbologies that actually appear on a vehicle.
 *
 * Code 39 is the AIAG standard and dominates door-jamb and windshield labels;
 * Code 128 appears on newer ones; Data Matrix shows up as a direct part mark.
 * Restricting the list is the single biggest speed lever — the decoder tries
 * each enabled format per frame, so four instead of twenty is roughly a
 * four-fold throughput gain.
 */
const VEHICLE_FORMATS = ['code_39', 'code_128', 'data_matrix', 'qr_code'] as const;

/** Decode attempts per second. */
const TARGET_FPS = 8;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

export interface ScanHit {
  vin: string;
  format: string;
  /** False when the check digit failed but the user may still accept it. */
  checkDigitValid: boolean;
}

export interface UseBarcodeScannerOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  active: boolean;
  onHit: (hit: ScanHit) => void;
  /**
   * Fraction of the frame, centred, that is actually decoded. A linear
   * barcode is wide and short, so the reticle is too — and cropping to it
   * both speeds up decoding and stops the scanner locking onto a barcode
   * elsewhere in shot.
   */
  cropRatio?: { width: number; height: number };
}

export interface UseBarcodeScannerResult {
  /** Frames attempted since the scanner started. Drives the progress hints. */
  attempts: number;
  /** A payload that decoded but was not a plausible VIN. */
  lastRejected: string | null;
}

export function useBarcodeScanner({
  videoRef,
  active,
  onHit,
  cropRatio = { width: 0.86, height: 0.34 },
}: UseBarcodeScannerOptions): UseBarcodeScannerResult {
  const [attempts, setAttempts] = useState(0);
  const [lastRejected, setLastRejected] = useState<string | null>(null);

  // Held in a ref so changing the handler does not restart the decode loop.
  // Assigned in an effect, because writing a ref during render is not allowed.
  const onHitRef = useRef(onHit);
  useEffect(() => {
    onHitRef.current = onHit;
  }, [onHit]);

  useEffect(() => {
    if (!active) return;

    prepareOnce();

    let cancelled = false;
    let raf = 0;
    let busy = false;
    let lastRun = 0;
    let frames = 0;

    const detector = new BarcodeDetector({ formats: [...VEHICLE_FORMATS] });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    const tick = async (time: number) => {
      if (cancelled) return;

      // Decoding every frame pegs the CPU, heats the phone into thermal
      // throttling, and does not improve the hit rate.
      if (!busy && time - lastRun >= FRAME_INTERVAL_MS) {
        busy = true;
        lastRun = time;

        try {
          const video = videoRef.current;
          // readyState 2 is HAVE_CURRENT_DATA.
          if (video && video.readyState >= 2 && video.videoWidth > 0 && context) {
            const cropWidth = Math.floor(video.videoWidth * cropRatio.width);
            const cropHeight = Math.floor(video.videoHeight * cropRatio.height);
            const sx = Math.floor((video.videoWidth - cropWidth) / 2);
            const sy = Math.floor((video.videoHeight - cropHeight) / 2);

            canvas.width = cropWidth;
            canvas.height = cropHeight;
            context.drawImage(video, sx, sy, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

            const results = await detector.detect(canvas);

            frames += 1;
            if (frames % 8 === 0) setAttempts(frames);

            for (const result of results) {
              const candidate = normalizeVin(result.rawValue);
              const classification = classifyVin(candidate);

              if (classification.kind === 'modern') {
                // Accepting only a valid check digit turns "scan something and
                // hope" into "scan until provably correct": a misread barcode
                // almost never produces a valid mod-11 check digit, so this is
                // free, instant error correction.
                if (isValidVin(candidate)) {
                  cancelled = true;
                  onHitRef.current({
                    vin: candidate,
                    format: result.format,
                    checkDigitValid: true,
                  });
                  return;
                }
                // A 17-character read with a bad check digit is worth
                // surfacing — mis-stamped and grey-import VINs are real.
                setLastRejected(candidate);
              } else if (classification.kind === 'legacy') {
                cancelled = true;
                onHitRef.current({
                  vin: candidate,
                  format: result.format,
                  checkDigitValid: false,
                });
                return;
              } else {
                setLastRejected(result.rawValue.slice(0, 40));
              }
            }
          }
        } catch {
          // Transient decode failures are the normal case, not an error.
        } finally {
          busy = false;
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      setAttempts(0);
    };
  }, [active, videoRef, cropRatio.width, cropRatio.height]);

  return { attempts, lastRejected };
}
