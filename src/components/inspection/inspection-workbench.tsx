'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  Loader2,
  MapPin,
  Plus,
  ShieldCheck,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { describeDamageCode, PHOTO_REQUIREMENTS, requiresHold } from '@/lib/aiag/codes';
import { capturePhoto, currentPosition } from '@/lib/offline/capture';
import { localDb, requestPersistentStorage, type LocalPhoto } from '@/lib/offline/db';
import { flushOutbox, startOutbox } from '@/lib/offline/outbox';
import { finalizeInspectionAction } from '@/app/(app)/loads/[id]/inspect/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import { vinDisplay } from '@/lib/utils/format';
import { DamagePicker, type DamageSelection } from './damage-picker';
import { PhotoSlots } from './photo-slots';
import { SignaturePad, type SignatureResult } from './signature-pad';

export interface InspectionWorkbenchProps {
  inspectionId: string;
  orgId: string;
  loadId: string;
  loadNumber: string;
  vehicleId: string;
  vin: string;
  vehicleLabel: string;
  stage: 'pickup' | 'delivery';
  tier: 'standard' | 'advanced' | 'aiag';
}

interface Details {
  odometer: string;
  fuelLevelEighths: number | null;
  keysPresent: boolean | null;
  personalItemsPresent: boolean | null;
  personalItemsNote: string;
  limitationNote: string;
}

export function InspectionWorkbench(props: InspectionWorkbenchProps) {
  const router = useRouter();

  /**
   * Photos come straight from IndexedDB and re-render when it changes.
   *
   * A live query rather than polling: the outbox mutates these rows from
   * outside React as uploads complete, and an interval would either lag behind
   * a capture or waste work between them.
   */
  const photos =
    useLiveQuery(
      () => localDb.photos.where('inspectionId').equals(props.inspectionId).toArray(),
      [props.inspectionId],
      [] as LocalPhoto[],
    ) ?? [];

  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [damages, setDamages] = useState<DamageSelection[]>([]);
  const [addingDamage, setAddingDamage] = useState(false);

  const [details, setDetails] = useState<Details>({
    odometer: '',
    fuelLevelEighths: null,
    keysPresent: null,
    personalItemsPresent: null,
    personalItemsNote: '',
    limitationNote: '',
  });

  const [signerName, setSignerName] = useState('');
  const [signature, setSignature] = useState<SignatureResult | null>(null);
  const [customerUnavailable, setCustomerUnavailable] = useState(false);

  const [position, setPosition] = useState<{
    latitude: string;
    longitude: string;
    accuracyM: number;
  } | null>(null);
  const [sealing, setSealing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const rules = PHOTO_REQUIREMENTS[props.tier];
  const pendingUploads = photos.filter((p) => p.uploadState !== 'uploaded').length;

  useEffect(() => {
    void requestPersistentStorage();
    void currentPosition().then(setPosition);
    // Drains the upload queue on reconnect and on a slow heartbeat.
    return startOutbox();
  }, []);

  const handleCapture = async (slot: string, file: File) => {
    setBusySlot(slot);
    setError(null);
    try {
      // Replacing a slot removes the old photo first, so the walk-around
      // cannot end up with two "left side" shots and an ambiguous record.
      const existing = photos.find((p) => p.slot === slot);
      if (existing) await localDb.photos.delete(existing.id);

      await capturePhoto({
        inspectionId: props.inspectionId,
        file,
        slot,
        position,
      });
      // The live query picks the new row up on its own; this just starts the
      // upload rather than waiting for the next heartbeat.
      void flushOutbox();
    } catch {
      setError('That photo could not be read. Try taking it again.');
    } finally {
      setBusySlot(null);
    }
  };

  const handleRemovePhoto = async (photoId: string) => {
    await localDb.photos.delete(photoId);
  };

  const seal = async () => {
    setSealing(true);
    setError(null);
    setProblems([]);

    // Push anything still queued before sealing, so the content hash covers
    // every photo rather than only those that happened to have uploaded.
    const flush = await flushOutbox();

    if (flush.remaining > 0) {
      setSealing(false);
      setError(
        `${flush.remaining} photo${flush.remaining === 1 ? '' : 's'} have not uploaded yet. ` +
          'They are safe on this device — reconnect and try again.',
      );
      return;
    }

    const result = await finalizeInspectionAction({
      inspectionId: props.inspectionId,
      details: {
        odometer: details.odometer === '' ? null : Number(details.odometer),
        fuelLevelEighths: details.fuelLevelEighths,
        keysPresent: details.keysPresent,
        personalItemsPresent: details.personalItemsPresent,
        personalItemsNote: details.personalItemsNote || null,
        limitationNote: details.limitationNote || null,
      },
      damages: damages.map((d) => ({
        areaCode: d.areaCode,
        typeCode: d.typeCode,
        severityCode: d.severityCode,
        description: d.description,
        nonTransportation: d.nonTransportation,
      })),
      signerName,
      signerRole: props.stage === 'pickup' ? 'shipper' : 'consignee',
      signatureMethod: 'drawn',
      signatureImage: signature?.dataUrl ?? null,
      signatureStrokes: signature?.strokes ?? null,
      customerUnavailable,
      clientClaimedAt: Date.now(),
      latitude: position?.latitude ?? null,
      longitude: position?.longitude ?? null,
      locationAccuracyM: position?.accuracyM ?? null,
      geoConsent: position !== null,
    });

    setSealing(false);

    if (!result.ok) {
      setError(result.error ?? 'The inspection could not be sealed.');
      setProblems(result.problems ?? []);
      return;
    }

    router.push(`/loads/${props.loadId}`);
    router.refresh();
  };

  const slotPhotoCount = photos.filter((p) => p.slot !== null).length;
  const photosComplete = slotPhotoCount >= rules.perStage;
  const signatureReady = !rules.requiresSignature || customerUnavailable || (signature !== null && signerName.trim().length >= 2);
  const canSeal = photosComplete && signatureReady && details.odometer !== '';

  return (
    <div className="space-y-6">
      {/* Context */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-sm break-all text-ink">{vinDisplay(props.vin)}</p>
            <p className="mt-0.5 text-xs text-ink-secondary">
              {props.vehicleLabel} · load {props.loadNumber}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={props.stage === 'pickup' ? 'brand' : 'info'} size="sm">
              {props.stage === 'pickup' ? 'Pickup' : 'Delivery'}
            </Badge>
            <Badge tone="neutral" size="sm" className="capitalize">
              {props.tier}
            </Badge>
            {position ? (
              <Badge tone="ok" size="sm">
                <MapPin aria-hidden />
                Located
              </Badge>
            ) : (
              <Badge tone="warn" size="sm">
                <MapPin aria-hidden />
                No fix
              </Badge>
            )}
          </div>
        </div>

        {props.stage === 'pickup' && (
          <p className="mt-3 rounded-lg bg-info-soft px-3 py-2 text-xs leading-relaxed text-info">
            Anything you mark now is recorded as pre-existing. This report is what clears your
            company of it if a claim arrives after delivery.
          </p>
        )}
      </Card>

      {error && (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5">
          <p className="flex items-start gap-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
          {problems.length > 0 && (
            <ul className="mt-2 space-y-1 pl-6 text-xs text-danger">
              {problems.map((problem) => (
                <li key={problem}>· {problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <PhotoSlots
        photos={photos}
        busySlot={busySlot}
        onCapture={(slot, file) => void handleCapture(slot, file)}
        onRemove={(id) => void handleRemovePhoto(id)}
      />

      {pendingUploads > 0 && (
        <p className="flex items-center gap-2 rounded-lg bg-sunken px-3 py-2 text-xs text-ink-secondary">
          <CloudUpload className="size-3.5 shrink-0 text-brand" aria-hidden />
          {pendingUploads} photo{pendingUploads === 1 ? '' : 's'} waiting to upload. They are saved
          on this device and will send themselves.
        </p>
      )}

      {/* Damage */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">
            Damage
            {damages.length > 0 && (
              <span className="ml-2 text-xs font-normal text-ink-secondary">
                {damages.length} marked
              </span>
            )}
          </h2>
          {!addingDamage && (
            <Button variant="secondary" size="sm" onClick={() => setAddingDamage(true)}>
              <Plus aria-hidden />
              Mark damage
            </Button>
          )}
        </div>

        {damages.length === 0 && !addingDamage && (
          <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-ink-muted">
            Nothing marked. If the vehicle is genuinely clean, that is the record — and it is what
            protects you at delivery.
          </p>
        )}

        {damages.length > 0 && (
          <ul className="space-y-2">
            {damages.map((damage, index) => (
              <li key={`${damage.code}-${index}`}>
                <Card className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-ink">{damage.code}</span>
                      {requiresHold(damage.code) && (
                        <Badge tone="warn" size="sm">
                          Hold
                        </Badge>
                      )}
                      {damage.nonTransportation && (
                        <Badge tone="neutral" size="sm">
                          Not transport damage
                        </Badge>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-ink-secondary">
                      {describeDamageCode(damage.code)}
                    </p>
                    {damage.description && (
                      <p className="mt-1 text-xs text-ink-muted">{damage.description}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDamages((d) => d.filter((_, i) => i !== index))}
                    aria-label={`Remove damage ${damage.code}`}
                    className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-danger-soft hover:text-danger"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </Card>
              </li>
            ))}
          </ul>
        )}

        <AnimatePresence>
          {addingDamage && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <Card className="mt-3 p-4">
                <DamagePicker
                  onCancel={() => setAddingDamage(false)}
                  onConfirm={(selection) => {
                    setDamages((d) => [...d, selection]);
                    setAddingDamage(false);
                  }}
                />
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* Condition details */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink">Condition</h2>
        <Card className="space-y-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Odometer"
              inputMode="numeric"
              required
              value={details.odometer}
              onChange={(e) =>
                setDetails((d) => ({ ...d, odometer: e.target.value.replace(/\D/g, '') }))
              }
              trailing={<span className="text-xs">mi</span>}
              hint="Must be legible in the odometer photo"
            />

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink">Fuel</span>
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((eighth) => (
                  <button
                    key={eighth}
                    type="button"
                    onClick={() => setDetails((d) => ({ ...d, fuelLevelEighths: eighth }))}
                    aria-label={`${eighth} eighths`}
                    aria-pressed={details.fuelLevelEighths === eighth}
                    className={cn(
                      'h-10 flex-1 rounded text-[0.625rem] transition-colors',
                      details.fuelLevelEighths === eighth
                        ? 'bg-brand text-brand-contrast'
                        : 'bg-sunken text-ink-muted hover:bg-raised',
                    )}
                  >
                    {eighth === 0 ? 'E' : eighth === 8 ? 'F' : `${eighth}`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            {(
              [
                ['keysPresent', 'Keys present'],
                ['personalItemsPresent', 'Personal items inside'],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                <input
                  type="checkbox"
                  checked={details[field] === true}
                  onChange={(e) => setDetails((d) => ({ ...d, [field]: e.target.checked }))}
                  className="size-4 rounded border-line accent-[var(--brand)]"
                />
                {label}
              </label>
            ))}
          </div>

          <div>
            <label htmlFor="limitation" className="block text-sm font-medium text-ink">
              Anything preventing a full inspection?
            </label>
            <textarea
              id="limitation"
              rows={2}
              value={details.limitationNote}
              onChange={(e) => setDetails((d) => ({ ...d, limitationNote: e.target.value }))}
              placeholder="Heavy road grime on the lower panels; inspected after dark under yard lighting."
              className="mt-1.5 w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
            />
            <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
              Worth writing down. Damage missed because a vehicle was dirty or snow-covered is
              explicitly <strong className="text-ink-secondary">not</strong> concealed damage, so
              noting the conditions here is what preserves your position later.
            </p>
          </div>
        </Card>
      </section>

      {/* Signature */}
      {rules.requiresSignature && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink">
            {props.stage === 'pickup' ? 'Shipper signature' : 'Consignee signature'}
          </h2>
          <Card className="space-y-4 p-4">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={customerUnavailable}
                onChange={(e) => setCustomerUnavailable(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 rounded border-line accent-[var(--brand)]"
              />
              <span>
                <span className="block text-sm text-ink">Nobody is available to sign</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  Recorded as driver-attested, which is weaker evidence than a signature. The
                  photographs carry the report instead.
                </span>
              </span>
            </label>

            {!customerUnavailable && (
              <>
                <Input
                  label="Printed name"
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  placeholder="Marcus Webb"
                  required
                />
                <SignaturePad onChange={setSignature} />
                {signature && signature.durationMs < 400 && (
                  <p className="flex items-start gap-1.5 text-xs text-warn">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                    That signature took under half a second. Ask them to sign as they normally
                    would — a hurried mark is easier to dispute.
                  </p>
                )}
              </>
            )}
          </Card>
        </section>
      )}

      {/* Seal */}
      <Card className="space-y-4 p-4">
        <ul className="space-y-1.5 text-xs">
          {[
            { done: photosComplete, label: `${rules.perStage} walk-around photos`, have: `${slotPhotoCount} captured` },
            { done: details.odometer !== '', label: 'Odometer recorded', have: details.odometer || 'not set' },
            { done: signatureReady, label: 'Signature', have: customerUnavailable ? 'driver attested' : signature ? 'captured' : 'not signed' },
            { done: pendingUploads === 0, label: 'Photos uploaded', have: pendingUploads === 0 ? 'all sent' : `${pendingUploads} queued` },
          ].map((item) => (
            <li key={item.label} className="flex items-center gap-2">
              {item.done ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-ok" aria-hidden />
              ) : (
                <span className="size-3.5 shrink-0 rounded-full border border-line" aria-hidden />
              )}
              <span className={item.done ? 'text-ink-secondary' : 'text-ink-muted'}>
                {item.label}
              </span>
              <span className="ml-auto text-ink-muted">{item.have}</span>
            </li>
          ))}
        </ul>

        <Button size="xl" block disabled={!canSeal} loading={sealing} onClick={() => void seal()}>
          {sealing ? (
            <>
              <Loader2 className="animate-spin" aria-hidden />
              Sealing
            </>
          ) : (
            <>
              <ShieldCheck aria-hidden />
              Sign and seal this inspection
            </>
          )}
        </Button>

        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
          <WifiOff className="mt-px size-3.5 shrink-0" aria-hidden />
          Sealing needs a connection. Everything you have captured is already saved on this device,
          so you can finish the walk-around now and seal when you have signal. Once sealed the
          report cannot be edited — a correction becomes an amendment that references it.
        </p>
      </Card>
    </div>
  );
}
