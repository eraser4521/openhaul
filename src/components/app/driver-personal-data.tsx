'use client';

import { useState } from 'react';
import { AlertCircle, Check, Eye, EyeOff, Lock, ShieldOff, Trash2 } from 'lucide-react';
import {
  erasePersonalDataAction,
  revealPersonalDataAction,
  savePersonalDataAction,
} from '@/app/(app)/drivers/pii-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * A driver's personal data, and the only screen that can destroy it.
 *
 * Nothing personal arrives with the page. The fields are blank until somebody
 * presses Reveal, which is a round trip that writes an audit entry — so the
 * log records a person looking at a licence number rather than a page being
 * rendered. Closing the panel drops it again.
 *
 * Erasure is deliberately awkward: a reason that goes on the record and the
 * driver's name typed exactly. There is no undo and no copy of the key
 * anywhere in the application, so it should cost more than one click.
 */

export type SubjectState = 'live' | 'erased' | 'none';

export interface PersonalFields {
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  dob: string | null;
  cdlNumber: string | null;
}

const BLANK: PersonalFields = {
  name: null,
  email: null,
  phone: null,
  address: null,
  dob: null,
  cdlNumber: null,
};

export function DriverPersonalData({
  driverId,
  driverName,
  state,
  erasedAt,
  canRead,
  canErase,
}: {
  driverId: string;
  driverName: string;
  state: SubjectState;
  erasedAt: string | null;
  canRead: boolean;
  canErase: boolean;
}) {
  const [revealed, setRevealed] = useState<PersonalFields | null>(null);
  const [editing, setEditing] = useState(false);
  const [erasing, setErasing] = useState(false);
  /*
   * Controlled, unlike the rest of the form fields here. A server action
   * resets an uncontrolled form when it returns, so a rejected confirmation
   * would wipe the reason the operator had just typed — on the one form in the
   * app where being made to start again is most likely to end in a shrug and a
   * second, less careful attempt.
   */
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!canRead) return null;

  if (state === 'erased') {
    return (
      <div className="rounded-lg bg-surface px-3 py-2.5">
        <p className="flex items-start gap-2 text-sm text-ink">
          <ShieldOff className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
          Personal data erased
          {erasedAt ? ` on ${new Date(erasedAt).toLocaleDateString('en-US')}` : ''}.
        </p>
        <p className="mt-1 pl-6 text-xs leading-relaxed text-ink-secondary">
          The key was destroyed, so this cannot be recovered. Loads, settlements and the documents
          already issued for this driver are untouched.
        </p>
      </div>
    );
  }

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await revealPersonalDataAction(driverId);
      if (result.ok && result.data) setRevealed(result.data);
      else setError(result.error ?? 'That could not be read.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const save = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await savePersonalDataAction(driverId, formData);
      if (result.ok) {
        setSaved(true);
        setEditing(false);
        setRevealed(null);
      } else {
        setError(result.error ?? 'That could not be saved.');
      }
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const erase = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await erasePersonalDataAction(driverId, formData);
      if (result.ok) {
        setErasing(false);
        setRevealed(null);
        setReason('');
        setConfirmation('');
      } else {
        setError(result.error ?? 'That could not be erased.');
      }
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const values = revealed ?? BLANK;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto flex items-center gap-1.5 text-xs font-medium tracking-wide text-ink-muted uppercase">
          <Lock className="size-3.5" aria-hidden />
          Personal data
        </p>

        {state === 'none' ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Add
          </Button>
        ) : (
          <>
            {revealed ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setRevealed(null)}>
                <EyeOff aria-hidden />
                Hide
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={busy && !editing && !erasing}
                onClick={() => void reveal()}
              >
                <Eye aria-hidden />
                Reveal
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(true);
                if (!revealed) void reveal();
              }}
            >
              Edit
            </Button>
            {canErase && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setErasing(true)}>
                <Trash2 aria-hidden />
                Erase
              </Button>
            )}
          </>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {saved && !editing && (
        <p className="flex items-center gap-1.5 text-xs text-ok">
          <Check className="size-3.5" aria-hidden />
          Saved and sealed
        </p>
      )}

      {state === 'none' && !editing && (
        <p className="text-xs leading-relaxed text-ink-secondary">
          Nothing on file. A licence number, date of birth or home address recorded here is sealed
          under a key belonging to this driver alone, so it can be destroyed later without touching
          the bills of lading you have to keep.
        </p>
      )}

      {revealed && !editing && (
        <dl className="grid gap-2 rounded-lg bg-surface px-3 py-2.5 text-sm sm:grid-cols-2">
          {(
            [
              ['Legal name', values.name],
              ['Date of birth', values.dob],
              ['Licence number', values.cdlNumber],
              ['Personal phone', values.phone],
              ['Personal email', values.email],
              ['Home address', values.address],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-ink-muted">{label}</dt>
              <dd className="mt-0.5 text-ink">{value || '—'}</dd>
            </div>
          ))}
          <p className="text-xs text-ink-muted sm:col-span-2">
            This view is on the audit log, with who read it and when.
          </p>
        </dl>
      )}

      {editing && (
        <form action={save} className="space-y-4 rounded-lg bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              name="name"
              label="Legal name"
              defaultValue={values.name ?? ''}
              hint="Where it differs from the name on the dispatch board."
            />
            <Input name="dob" label="Date of birth" placeholder="1984-03-11" defaultValue={values.dob ?? ''} />
            <Input name="cdlNumber" label="Licence number" defaultValue={values.cdlNumber ?? ''} />
            <Input name="phone" label="Personal phone" defaultValue={values.phone ?? ''} />
            <Input name="email" label="Personal email" defaultValue={values.email ?? ''} />
            <Input name="address" label="Home address" defaultValue={values.address ?? ''} />
          </div>

          <p className="text-xs leading-relaxed text-ink-muted">
            The driver&rsquo;s display name, pay and licence class stay on the driver record — the
            app cannot dispatch a load without them, and they are printed on documents you are
            required to keep. Only the fields above are sealed.
          </p>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Save
            </Button>
          </div>
        </form>
      )}

      {erasing && (
        <form action={erase} className="space-y-4 rounded-lg bg-danger-soft p-4">
          <div>
            <p className="flex items-start gap-2 text-sm font-medium text-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              Erase {driverName}&rsquo;s personal data
            </p>
            <p className="mt-1 pl-6 text-xs leading-relaxed text-ink-secondary">
              This destroys the key that seals it. The data becomes unreadable immediately and
              permanently — there is no copy of the key anywhere in this application. Loads,
              settlements, the audit chain and every document already issued are untouched and stay
              valid.
            </p>
            <p className="mt-1.5 pl-6 text-xs leading-relaxed text-warn">
              A backup taken before today still holds the key and the data together. Erasure is only
              complete once those have aged out of your backup rotation.
            </p>
          </div>

          <div className="grid gap-4">
            <Input
              name="reason"
              label="Why"
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Erasure request received 14 Sep 2026"
              hint="Recorded on the audit chain."
            />
            <Input
              name="confirm"
              label={`Type “${driverName}” to confirm`}
              required
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setErasing(false);
                setError(null);
                setReason('');
                setConfirmation('');
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              <Trash2 aria-hidden />
              Erase permanently
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
