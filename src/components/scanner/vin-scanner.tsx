'use client';

import { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Camera, Flashlight, Keyboard, RefreshCw, ScanLine, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { CAMERA_ERROR_MESSAGES, useCamera } from './use-camera';
import { useBarcodeScanner, type ScanHit } from './use-barcode-scanner';
import { VinInput } from './vin-input';

export interface VinScannerProps {
  onCapture: (vin: string, meta: { source: 'scan' | 'manual'; checkDigitValid: boolean }) => void;
  onCancel?: () => void;
  className?: string;
}

/**
 * Camera VIN capture, with manual entry always one tap away.
 */
export function VinScanner({ onCapture, onCancel, className }: VinScannerProps) {
  // The component owns the video element, and hands the ref to both the
  // camera lifecycle and the decode loop.
  const videoRef = useRef<HTMLVideoElement>(null);
  const camera = useCamera(videoRef);
  const [requestedMode, setMode] = useState<'idle' | 'scanning' | 'manual'>('idle');
  // A camera failure always drops back to idle. Derived during render rather
  // than synchronised by an effect, which would render one frame in the wrong
  // state before correcting itself.
  const mode = requestedMode === 'scanning' && camera.error ? 'idle' : requestedMode;
  const [manualVin, setManualVin] = useState('');
  const [hit, setHit] = useState<ScanHit | null>(null);

  const handleHit = useCallback(
    (found: ScanHit) => {
      setHit(found);
      camera.stop();
      // Short vibration as tactile confirmation: a driver in gloves and
      // sunlight often cannot see the screen change.
      navigator.vibrate?.(60);
    },
    [camera],
  );

  const scanner = useBarcodeScanner({
    videoRef,
    active: mode === 'scanning' && camera.active,
    onHit: handleHit,
  });

  // iOS requires getUserMedia to be triggered by a user gesture, so the camera
  // is never started on mount. It is also better permission UX: the browser
  // prompt arrives only after the user has asked for the camera.
  const startScanning = async () => {
    setHit(null);
    setMode('scanning');
    await camera.start();
  };

  const stopScanning = () => {
    camera.stop();
    setMode('idle');
  };

  const accept = (vin: string, source: 'scan' | 'manual', checkDigitValid: boolean) => {
    camera.stop();
    onCapture(vin, { source, checkDigitValid });
  };

  const elapsedHint =
    scanner.attempts > 80
      ? 'Still nothing. Try the door jamb sticker instead of the windshield, or type it in.'
      : scanner.attempts > 32
        ? 'Move closer and keep the barcode square in the box. Wipe the label if it is dirty.'
        : null;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-line bg-black">
        {/*
          Never `display: none` a live video on iOS 18 — it ends the track with
          a capture failure and yields a blank stream. Opacity instead.
        */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={cn(
            'size-full object-cover transition-opacity duration-300',
            camera.active ? 'opacity-100' : 'opacity-0',
          )}
        />

        {camera.active && !hit && (
          <>
            <div className="pointer-events-none absolute inset-0">
              {/* Dim everything outside the reticle. */}
              <div className="absolute inset-0 bg-black/45" />
              {/*
                A wide, short window matching a linear barcode's aspect ratio.
                Users aim at what you draw: a square box makes them hold the
                phone too far back, shrinking the barcode below the resolution
                the decoder needs.
              */}
              <div className="absolute top-1/2 left-1/2 h-[34%] w-[86%] -translate-x-1/2 -translate-y-1/2">
                <div className="absolute inset-0 rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
                <div className="absolute inset-0 rounded-lg ring-2 ring-white/80" />
                {(['top-0 left-0', 'top-0 right-0', 'bottom-0 left-0', 'bottom-0 right-0'] as const).map(
                  (corner) => (
                    <span
                      key={corner}
                      className={cn('absolute size-6 border-brand', corner, {
                        'rounded-tl-lg border-t-4 border-l-4': corner === 'top-0 left-0',
                        'rounded-tr-lg border-t-4 border-r-4': corner === 'top-0 right-0',
                        'rounded-bl-lg border-b-4 border-l-4': corner === 'bottom-0 left-0',
                        'rounded-br-lg border-r-4 border-b-4': corner === 'bottom-0 right-0',
                      })}
                    />
                  ),
                )}
                <div className="animate-sweep absolute inset-x-2 top-0 h-0.5 rounded-full bg-brand shadow-[0_0_12px_var(--brand)]" />
              </div>
            </div>

            <p className="absolute inset-x-0 bottom-4 px-6 text-center text-xs text-white/90">
              {elapsedHint ?? 'Fill the box with the barcode on the door jamb or windshield label.'}
            </p>
          </>
        )}

        {!camera.active && !hit && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            {camera.error ? (
              <div className="max-w-sm">
                <h3 className="text-sm font-semibold text-white">
                  {CAMERA_ERROR_MESSAGES[camera.error].title}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-white/70">
                  {CAMERA_ERROR_MESSAGES[camera.error].body}
                </p>
              </div>
            ) : (
              <div className="max-w-xs">
                <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-white/10">
                  <Camera className="size-6 text-white" aria-hidden />
                </span>
                <p className="mt-4 text-sm font-medium text-white">Scan the VIN barcode</p>
                <p className="mt-1.5 text-xs leading-relaxed text-white/60">
                  The camera runs entirely on this device. Nothing is uploaded while scanning.
                </p>
              </div>
            )}
          </div>
        )}

        <AnimatePresence>
          {hit && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 grid place-items-center bg-black/85 p-6"
            >
              <div className="w-full max-w-sm text-center">
                <span className="mx-auto grid size-12 place-items-center rounded-full bg-ok-soft">
                  <ScanLine className="size-5 text-ok" aria-hidden />
                </span>
                <p className="mt-4 font-mono text-lg tracking-wider break-all text-white">
                  {hit.vin}
                </p>
                <p className="mt-2 text-xs text-white/60">
                  Read as {hit.format.replace(/_/g, ' ')}
                  {hit.checkDigitValid ? ' · check digit valid' : ' · no check digit to verify'}
                </p>
                <div className="mt-5 flex gap-2">
                  <Button
                    variant="secondary"
                    size="lg"
                    block
                    onClick={() => {
                      setHit(null);
                      void startScanning();
                    }}
                  >
                    <RefreshCw aria-hidden />
                    Rescan
                  </Button>
                  <Button
                    size="lg"
                    block
                    onClick={() => accept(hit.vin, 'scan', hit.checkDigitValid)}
                  >
                    Use this VIN
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {camera.active && camera.capabilities.torch && (
          <button
            type="button"
            onClick={() => void camera.toggleTorch()}
            aria-pressed={camera.torchOn}
            aria-label="Toggle the camera light"
            className={cn(
              'absolute top-3 right-3 grid size-10 place-items-center rounded-full backdrop-blur transition-colors',
              camera.torchOn ? 'bg-brand text-brand-contrast' : 'bg-black/50 text-white',
            )}
          >
            <Flashlight className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {/* Torch is Chromium-only, so on iOS this hint replaces a dead button. */}
      {camera.active && !camera.capabilities.torch && (
        <p className="-mt-2 text-center text-xs text-ink-muted">
          Scanning through glass? Angle the phone to kill reflections rather than adding light.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {mode !== 'scanning' ? (
          <Button size="lg" onClick={() => void startScanning()} loading={camera.starting}>
            <Camera aria-hidden />
            {camera.error ? 'Try the camera again' : 'Start camera'}
          </Button>
        ) : (
          <Button size="lg" variant="secondary" onClick={stopScanning}>
            <X aria-hidden />
            Stop camera
          </Button>
        )}

        <Button
          size="lg"
          variant={mode === 'manual' ? 'primary' : 'outline'}
          onClick={() => {
            camera.stop();
            setMode(mode === 'manual' ? 'idle' : 'manual');
          }}
        >
          <Keyboard aria-hidden />
          Type it in
        </Button>

        {onCancel && (
          <Button size="lg" variant="ghost" onClick={onCancel} className="ml-auto">
            Cancel
          </Button>
        )}
      </div>

      {camera.devices.length > 1 && mode === 'scanning' && (
        <label className="flex items-center gap-2 text-xs text-ink-secondary">
          <span className="shrink-0">Camera</span>
          <select
            value={camera.selectedDeviceId ?? ''}
            onChange={(e) => void camera.selectDevice(e.target.value)}
            className="h-9 flex-1 rounded-lg border border-line bg-raised px-2 text-xs text-ink"
          >
            {camera.devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <AnimatePresence>
        {mode === 'manual' && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="rounded-xl border border-line bg-raised p-4">
              <VinInput value={manualVin} onChange={setManualVin} autoFocus />
              <Button
                className="mt-4"
                block
                size="lg"
                disabled={manualVin.length < 5}
                onClick={() => {
                  const classification =
                    manualVin.length === 17 ? { valid: true } : { valid: false };
                  accept(manualVin, 'manual', classification.valid);
                }}
              >
                Use this VIN
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {scanner.lastRejected && mode === 'scanning' && (
        <p className="text-center text-xs text-ink-muted">
          Read <span className="font-mono">{scanner.lastRejected}</span>, which is not a valid VIN.
          Still looking.
        </p>
      )}
    </div>
  );
}
