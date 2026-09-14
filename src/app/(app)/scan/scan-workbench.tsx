'use client';

import { useCallback, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Check, Loader2, RotateCcw, WifiOff } from 'lucide-react';
import { VinScanner } from '@/components/scanner/vin-scanner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { decodeModelYear, getWmi } from '@/lib/vin';
import { vinDisplay } from '@/lib/utils/format';
import type { DecodedVehicle } from '@/lib/vin';

interface DecodeResponse {
  vin: string;
  cached?: boolean;
  offline?: boolean;
  legacy?: boolean;
  message?: string;
  vehicle?: Partial<DecodedVehicle> & { vin: string };
  error?: string;
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="border-b border-line py-2.5 last:border-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value}</dd>
    </div>
  );
}

export function ScanWorkbench() {
  const [captured, setCaptured] = useState<{ vin: string; checkDigitValid: boolean } | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [result, setResult] = useState<DecodeResponse | null>(null);

  const handleCapture = useCallback(
    async (vin: string, meta: { source: 'scan' | 'manual'; checkDigitValid: boolean }) => {
      setCaptured({ vin, checkDigitValid: meta.checkDigitValid });
      setResult(null);
      setDecoding(true);

      try {
        const response = await fetch(`/api/vin/decode?vin=${encodeURIComponent(vin)}`);
        setResult((await response.json()) as DecodeResponse);
      } catch {
        // The decode is an enrichment, not a gate. Everything the app needs to
        // record the vehicle is already in hand.
        setResult({
          vin,
          offline: true,
          message: 'No connection. The VIN is saved; details will fill in when you are back online.',
        });
      } finally {
        setDecoding(false);
      }
    },
    [],
  );

  const reset = () => {
    setCaptured(null);
    setResult(null);
  };

  // Decoded entirely on-device, so it renders instantly and still works with
  // no signal at all.
  const localYear = captured ? decodeModelYear(captured.vin).year : null;
  const vehicle = result?.vehicle;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div>
        {!captured ? (
          <VinScanner onCapture={handleCapture} />
        ) : (
          <Card className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs text-ink-muted">Captured VIN</p>
                <p className="mt-1 font-mono text-lg break-all text-ink">
                  {vinDisplay(captured.vin)}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={reset}>
                <RotateCcw aria-hidden />
                Scan another
              </Button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {captured.checkDigitValid ? (
                <Badge tone="ok">
                  <Check aria-hidden />
                  Check digit valid
                </Badge>
              ) : (
                <Badge tone="warn">
                  <AlertTriangle aria-hidden />
                  Check digit unverified
                </Badge>
              )}
              {localYear && <Badge tone="neutral">{localYear} model year</Badge>}
              <Badge tone="neutral">WMI {getWmi(captured.vin)}</Badge>
              {result?.cached && <Badge tone="neutral">From cache</Badge>}
            </div>

            {!captured.checkDigitValid && (
              <p className="mt-4 rounded-lg bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-warn">
                This VIN did not pass its own check digit. Compare it against the plate before you
                put it on a bill of lading — but mis-stamped, imported and trailer VINs do fail
                legitimately, so it is recorded either way.
              </p>
            )}
          </Card>
        )}
      </div>

      <div className="space-y-4">
        <AnimatePresence mode="wait">
          {decoding && (
            <motion.div
              key="decoding"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <Card className="flex items-center gap-3 p-5">
                <Loader2 className="size-4 animate-spin text-brand" aria-hidden />
                <p className="text-sm text-ink-secondary">Looking up the vehicle with NHTSA…</p>
              </Card>
            </motion.div>
          )}

          {!decoding && result && (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <Card>
                <div className="border-b border-line px-5 py-4">
                  <h2 className="text-sm font-semibold text-ink">Vehicle</h2>
                  {result.offline && (
                    <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-warn">
                      <WifiOff className="mt-px size-3.5 shrink-0" aria-hidden />
                      {result.message}
                    </p>
                  )}
                  {result.legacy && (
                    <p className="mt-2 text-xs leading-relaxed text-info">{result.message}</p>
                  )}
                  {result.error && (
                    <p className="mt-2 text-xs leading-relaxed text-danger">{result.error}</p>
                  )}
                </div>

                <dl className="px-5 py-1">
                  <Field label="Year" value={vehicle?.modelYear ?? localYear} />
                  <Field label="Make" value={vehicle?.make} />
                  <Field label="Model" value={vehicle?.model} />
                  <Field label="Trim" value={vehicle?.trim} />
                  <Field label="Body class" value={vehicle?.bodyClass} />
                  <Field label="Vehicle type" value={vehicle?.vehicleType} />
                  <Field label="Drive type" value={vehicle?.driveType} />
                  <Field label="Fuel" value={vehicle?.fuelType} />
                  <Field label="GVWR" value={vehicle?.gvwr} />
                  <Field label="Manufacturer" value={vehicle?.manufacturer} />
                  <Field label="Built in" value={vehicle?.plantCountry} />
                </dl>

                {vehicle?.suggestedVin && vehicle.suggestedVin !== captured?.vin && (
                  <div className="border-t border-line px-5 py-4">
                    <p className="text-xs text-ink-secondary">
                      NHTSA thinks this VIN has a single-character error and suggests:
                    </p>
                    <p className="mt-1.5 font-mono text-sm break-all text-ink">
                      {vehicle.suggestedVin}
                    </p>
                  </div>
                )}

                {vehicle?.errorCodes && vehicle.errorCodes.length > 0 && (
                  <div className="border-t border-line px-5 py-4">
                    <ul className="space-y-1.5">
                      {vehicle.errorCodes
                        .filter((e) => e.code !== 0)
                        .map((e) => (
                          <li
                            key={e.code}
                            className={`text-xs leading-relaxed ${e.benign ? 'text-ink-muted' : 'text-warn'}`}
                          >
                            {e.message}
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {!captured && (
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink">Getting a clean read</h2>
            <ul className="mt-3 space-y-2.5 text-xs leading-relaxed text-ink-secondary">
              <li>
                <strong className="text-ink">Fill the box.</strong> A VIN barcode is long and thin.
                Get close enough that it spans the whole reticle.
              </li>
              <li>
                <strong className="text-ink">Prefer the door jamb.</strong> Windshield labels sit
                behind glass that reflects straight back at the lens.
              </li>
              <li>
                <strong className="text-ink">Do not add light through glass.</strong> Change the
                angle instead — a torch bounces off the windscreen.
              </li>
              <li>
                <strong className="text-ink">Wipe the label.</strong> Road grime defeats the
                scanner far more often than a bad camera does.
              </li>
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
