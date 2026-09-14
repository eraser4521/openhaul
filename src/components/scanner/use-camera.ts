'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Camera lifecycle for the VIN scanner.
 *
 * Kept separate from the decode loop so the "camera stays on after unmount"
 * bug has exactly one place it can come from.
 */

export type CameraError =
  | 'denied'
  | 'not-found'
  | 'in-use'
  | 'insecure-context'
  | 'over-constrained'
  | 'unknown';

export interface CameraCapabilities {
  torch: boolean;
  zoom: { min: number; max: number } | null;
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface UseCameraResult {
  active: boolean;
  starting: boolean;
  error: CameraError | null;
  capabilities: CameraCapabilities;
  torchOn: boolean;
  devices: CameraDevice[];
  selectedDeviceId: string | null;
  start: (deviceId?: string) => Promise<void>;
  stop: () => void;
  toggleTorch: () => Promise<void>;
  selectDevice: (deviceId: string) => Promise<void>;
}

function classifyError(error: unknown): CameraError {
  if (!(error instanceof Error)) return 'unknown';
  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'not-found';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'in-use';
    case 'OverconstrainedError':
      return 'over-constrained';
    default:
      return 'unknown';
  }
}

/**
 * Multi-lens phones expose ultra-wide, wide and telephoto as separate devices.
 * `facingMode: environment` often picks the ultra-wide, which has the worst
 * effective resolution for a small distant barcode and a close-focus minimum
 * that makes it worse. Prefer a lens that does not advertise itself as one.
 */
function preferredDevice(devices: CameraDevice[]): CameraDevice | null {
  if (devices.length === 0) return null;
  const rear = devices.filter((d) => /back|rear|environment/i.test(d.label));
  const pool = rear.length > 0 ? rear : devices;
  const plain = pool.find((d) => !/ultra|wide|telephoto|depth/i.test(d.label));
  return plain ?? pool[0] ?? null;
}

/**
 * @param videoRef The element the preview renders into. Owned by the caller so
 *   that this hook's return value contains only state.
 */
export function useCamera(videoRef: React.RefObject<HTMLVideoElement | null>): UseCameraResult {
  const streamRef = useRef<MediaStream | null>(null);
  /** Ensures the ultra-wide correction below runs at most once per mount. */
  const lensCorrectedRef = useRef(false);

  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<CameraError | null>(null);
  const [capabilities, setCapabilities] = useState<CameraCapabilities>({ torch: false, zoom: null });
  const [torchOn, setTorchOn] = useState(false);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setActive(false);
    setTorchOn(false);
  }, [videoRef]);

  const startRef = useRef<(deviceId?: string) => Promise<void>>(async () => {});

  const start = useCallback(
    async (deviceId?: string) => {
      // getUserMedia needs a secure context. localhost counts as secure.
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setError('insecure-context');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('not-found');
        return;
      }

      setStarting(true);
      setError(null);
      stop();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
            : {
                // 'ideal' rather than 'exact': 'exact' throws on a laptop with
                // only a front camera, which kills the whole flow.
                facingMode: { ideal: 'environment' },
                // A 17-character Code 39 strip is long and thin. At 640x480
                // there are simply not enough horizontal pixels to resolve the
                // narrow bars, and this is the single largest cause of failed
                // VIN scans.
                width: { ideal: 1920 },
                height: { ideal: 1080 },
              },
          audio: false,
        });

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {
            // Autoplay rejection is recoverable; the element is muted and
            // playsInline, so this is rare.
          });
        }

        const track = stream.getVideoTracks()[0];
        if (track) {
          setSelectedDeviceId(track.getSettings().deviceId ?? null);

          // Torch, zoom and focus constraints are Chromium-only. Every iOS
          // browser is WKWebView, so none of them have torch control — hide
          // the button rather than showing a dead one.
          const caps = track.getCapabilities?.() as
            | { torch?: boolean; zoom?: { min: number; max: number } }
            | undefined;
          setCapabilities({
            torch: Boolean(caps?.torch),
            zoom: caps?.zoom ? { min: caps.zoom.min, max: caps.zoom.max } : null,
          });
        }

        // Labels are empty until permission has been granted once, so this
        // runs after getUserMedia rather than before.
        const all = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = all
          .filter((d) => d.kind === 'videoinput')
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
        setDevices(videoInputs);

        setActive(true);

        // If the browser handed us an ultra-wide, switch once to a lens that
        // can actually resolve a barcode. Guarded so this can never loop:
        // the retry passes an explicit deviceId, which skips this branch.
        if (!deviceId && !lensCorrectedRef.current) {
          lensCorrectedRef.current = true;
          const activeLabel = track?.getSettings().deviceId
            ? (videoInputs.find((d) => d.deviceId === track.getSettings().deviceId)?.label ?? '')
            : '';

          if (/ultra|wide|telephoto|depth/i.test(activeLabel)) {
            const better = preferredDevice(videoInputs);
            if (better && better.deviceId !== track?.getSettings().deviceId) {
              await startRef.current(better.deviceId);
              return;
            }
          }
        }
      } catch (caught) {
        setError(classifyError(caught));
        stop();
      } finally {
        setStarting(false);
      }
    },
    [stop, videoRef],
  );

  // Assigned in an effect rather than during render. `start` is only ever
  // invoked from an event handler, so the ref is populated well before the
  // lens-correction path can read it.
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  const selectDevice = useCallback(
    async (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      await start(deviceId);
    },
    [start],
  );

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !capabilities.torch) return;
    const next = !torchOn;
    try {
      // `torch` is a Chromium extension that the TypeScript DOM lib does not
      // model, so the constraint is widened through `unknown`.
      await track.applyConstraints({
        advanced: [{ torch: next }],
      } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      setCapabilities((c) => ({ ...c, torch: false }));
    }
  }, [capabilities.torch, torchOn]);

  // Release the camera when the tab is hidden. Android in particular will hand
  // it to another app and leave a dead track behind.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [stop]);

  // iOS will not reliably release the camera otherwise, and the indicator
  // light stays on — which users correctly report as a privacy bug.
  useEffect(() => stop, [stop]);

  return {
    active,
    starting,
    error,
    capabilities,
    torchOn,
    devices,
    selectedDeviceId,
    start,
    stop,
    toggleTorch,
    selectDevice,
  };
}

export const CAMERA_ERROR_MESSAGES: Record<CameraError, { title: string; body: string }> = {
  denied: {
    title: 'Camera access is blocked',
    body: 'Your browser is blocking the camera for this site. Open the site settings — usually the icon in the address bar — allow the camera, then reload. You can also type the VIN in by hand.',
  },
  'not-found': {
    title: 'No camera found',
    body: 'This device has no camera available to the browser. Type the VIN in by hand instead.',
  },
  'in-use': {
    title: 'The camera is busy',
    body: 'Another app is using the camera. Close it and try again.',
  },
  'insecure-context': {
    title: 'A secure connection is required',
    body: 'Browsers only allow camera access over HTTPS. Reach this page over https, or use localhost during development.',
  },
  'over-constrained': {
    title: 'This camera cannot be used',
    body: 'The selected camera does not support the settings the scanner needs. Try a different one.',
  },
  unknown: {
    title: 'The camera could not be started',
    body: 'Something went wrong starting the camera. Try again, or type the VIN in by hand.',
  },
};
