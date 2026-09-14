'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Eye, ImageOff, Info, Trash2, Upload } from 'lucide-react';
import { saveTemplateAction } from '@/app/(app)/settings/template-actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { assessAccent } from '@/lib/branding/color';
import type { TemplateScope } from '@/lib/db/schema';

/**
 * The template settings.
 *
 * Built around one idea the carrier has to be able to see: there is a layer of
 * these documents that is theirs and a layer that is not. Everything on this
 * screen is the first layer. The second is named where a field would otherwise
 * look like it might reach it, because a carrier who thinks they can edit the
 * terms of a bill of lading and cannot find the field will assume the software
 * is broken rather than that the answer is no.
 *
 * Empty means inherit, everywhere. A scope with nothing filled in uses the
 * house style, and the placeholder shows what that currently is — so clearing
 * a field is a visible act with a visible result rather than an ambiguity.
 */

export interface TemplateValues {
  letterheadName: string | null;
  tagline: string | null;
  accentHex: string | null;
  showLogo: boolean | null;
  footerNote: string | null;
  addendum: string | null;
  remitToText: string | null;
}

export interface TemplateEditorProps {
  canEdit: boolean;
  legalName: string;
  house: TemplateValues;
  overrides: Partial<Record<TemplateScope, TemplateValues>>;
  logo: { width: number; height: number; sha256: string } | null;
}

const SCOPES: Array<{ value: TemplateScope; label: string }> = [
  { value: 'all', label: 'House style' },
  { value: 'bol', label: 'Bill of lading' },
  { value: 'pod', label: 'Delivery receipt' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'credit_note', label: 'Credit note' },
  { value: 'settlement', label: 'Settlement' },
  { value: 'claim', label: 'Claim letters' },
];

/** Where the carrier's extra terms are actually printed. */
const ADDENDUM_SCOPES: TemplateScope[] = ['all', 'bol', 'pod', 'invoice', 'settlement'];
/** Where a remittance block replaces the office address. */
const REMIT_SCOPES: TemplateScope[] = ['all', 'invoice', 'credit_note'];

const EMPTY: TemplateValues = {
  letterheadName: null,
  tagline: null,
  accentHex: null,
  showLogo: null,
  footerNote: null,
  addendum: null,
  remitToText: null,
};

export function TemplateEditor({
  canEdit,
  legalName,
  house,
  overrides,
  logo: initialLogo,
}: TemplateEditorProps) {
  const [scope, setScope] = useState<TemplateScope>('all');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [logo, setLogo] = useState(initialLogo);
  const [logoBusy, setLogoBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [accent, setAccent] = useState(house.accentHex ?? '');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const values = (scope === 'all' ? house : overrides[scope]) ?? EMPTY;
  const isHouse = scope === 'all';

  // Only the house row holds a colour worth previewing live; a scope override
  // is read from the field the carrier is typing into.
  const assessed = assessAccent(accent);

  /*
   * The colour field is controlled, so the swatch and the contrast note can
   * react as it is typed. That means switching document has to reset it here,
   * where the uncontrolled fields reset themselves when the form remounts.
   */
  const selectScope = (next: TemplateScope) => {
    const nextValues = (next === 'all' ? house : overrides[next]) ?? EMPTY;
    setScope(next);
    setAccent(nextValues.accentHex ?? '');
    setSaved(false);
    setError(null);
  };

  // Blob URLs outlive the component unless they are revoked, and a carrier
  // trying colours will make a dozen of them.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const currentFields = (): TemplateValues => {
    const form = formRef.current;
    if (!form) return values;
    const data = new FormData(form);
    const text = (name: string) => {
      const raw = String(data.get(name) ?? '').trim();
      return raw || null;
    };
    return {
      letterheadName: text('letterheadName'),
      tagline: text('tagline'),
      accentHex: text('accentHex'),
      showLogo: data.has('showLogo') ? data.get('showLogo') === 'on' : null,
      footerNote: text('footerNote'),
      addendum: text('addendum'),
      remitToText: text('remitToText'),
    };
  };

  const preview = async () => {
    setPreviewing(true);
    setError(null);
    try {
      const response = await fetch('/api/branding/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, fields: currentFields() }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? 'The preview could not be rendered.');
        return;
      }

      const blob = await response.blob();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch {
      setError('The preview could not be rendered.');
    } finally {
      setPreviewing(false);
    }
  };

  const save = async (formData: FormData) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await saveTemplateAction(scope, formData);
      if (result.ok) setSaved(true);
      else setError(result.error ?? 'That could not be saved.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (file: File) => {
    setLogoBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('logo', file);
      const response = await fetch('/api/branding/logo', {
        method: 'POST',
        body,
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        width?: number;
        height?: number;
        sha256?: string;
      } | null;

      if (!response.ok || !result?.ok) {
        setError(result?.error ?? 'That image could not be used.');
        return;
      }

      setLogo({
        width: result.width ?? 0,
        height: result.height ?? 0,
        sha256: result.sha256 ?? '',
      });
    } catch {
      setError('That upload did not go through.');
    } finally {
      setLogoBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const removeLogo = async () => {
    setLogoBusy(true);
    try {
      const response = await fetch('/api/branding/logo', { method: 'DELETE' });
      if (response.ok) setLogo(null);
      else setError('The logo could not be removed.');
    } catch {
      setError('That did not go through.');
    } finally {
      setLogoBusy(false);
    }
  };

  const placeholderFor = (field: keyof TemplateValues): string => {
    if (isHouse) return '';
    const inherited = house[field];
    if (inherited === null || inherited === undefined) return 'Nothing set';
    return typeof inherited === 'string' ? inherited : '';
  };

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">Document templates</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
          Your letterhead, your colour and your own terms, on documents whose regulatory content
          stays where it is. Nothing here can change the terms on a bill of lading, the
          non-negotiable declaration on its face, or what a claim letter says — those are what make
          the document the document.
        </p>
      </div>

      {!canEdit ? (
        <p className="p-5 text-sm text-ink-secondary">Only an owner can change the templates.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 border-b border-line px-5 py-3">
            {SCOPES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => selectScope(option.value)}
                className={
                  scope === option.value
                    ? 'rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-raised'
                    : 'rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink'
                }
              >
                {option.label}
              </button>
            ))}
          </div>

          {!isHouse && (
            <p className="flex items-start gap-2 border-b border-line px-5 py-3 text-xs leading-relaxed text-ink-secondary">
              <Info className="mt-px size-3.5 shrink-0 text-ink-muted" aria-hidden />
              Anything left empty here uses the house style. Fill a field in to override it for this
              document only.
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 border-b border-line bg-danger-soft px-5 py-3 text-sm text-danger"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          <form action={save} ref={formRef} key={scope}>
            <div className="grid gap-5 p-5">
              {isHouse && (
                <div>
                  <p className="text-sm font-medium text-ink">Logo</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                    PNG, JPEG or WebP. Converted to PNG so a transparent background stays
                    transparent, and printed at most 168 points wide — about 2⅓ inches.
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <div className="flex h-16 w-44 items-center justify-center rounded-lg border border-line bg-surface p-2">
                      {logo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/branding/logo?v=${logo.sha256.slice(0, 12)}`}
                          alt="Your logo"
                          className="max-h-full max-w-full object-contain"
                        />
                      ) : (
                        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                          <ImageOff className="size-3.5" aria-hidden />
                          None
                        </span>
                      )}
                    </div>

                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadLogo(file);
                      }}
                    />

                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      loading={logoBusy}
                      onClick={() => fileInput.current?.click()}
                    >
                      <Upload aria-hidden />
                      {logo ? 'Replace' : 'Upload'}
                    </Button>

                    {logo && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={logoBusy}
                        onClick={() => void removeLogo()}
                      >
                        <Trash2 aria-hidden />
                        Remove
                      </Button>
                    )}
                  </div>

                  {logo && (
                    <p className="mt-2 text-xs text-ink-muted">
                      {logo.width} × {logo.height} px. Documents already issued keep the logo they
                      were sealed with — replacing it here changes nothing that has been sent.
                    </p>
                  )}
                </div>
              )}

              {!isHouse && (
                <label className="flex items-start gap-2.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    name="showLogo"
                    defaultChecked={values.showLogo ?? house.showLogo ?? true}
                    className="mt-0.5 size-4 rounded border-line"
                  />
                  <span>
                    Print the logo on this document
                    <span className="mt-0.5 block text-xs text-ink-secondary">
                      Uncheck to leave it off this one document while keeping it everywhere else.
                    </span>
                  </span>
                </label>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  name="letterheadName"
                  label="Name on the letterhead"
                  defaultValue={values.letterheadName ?? ''}
                  placeholder={isHouse ? legalName : placeholderFor('letterheadName')}
                  hint={
                    isHouse
                      ? 'Leave empty to print no name — a logo usually carries it already.'
                      : undefined
                  }
                />
                <Input
                  name="tagline"
                  label="Tagline"
                  defaultValue={values.tagline ?? ''}
                  placeholder={
                    isHouse ? 'Enclosed auto transport since 2011' : placeholderFor('tagline')
                  }
                />
              </div>

              <div>
                <label htmlFor="accentHex" className="text-sm font-medium text-ink">
                  Accent colour
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Pick an accent colour"
                    value={`#${assessed.color ? accent.replace('#', '') : '1f4e79'}`}
                    onChange={(event) => setAccent(event.target.value.replace('#', ''))}
                    className="h-10 w-12 cursor-pointer rounded-lg border border-line bg-raised p-1"
                  />
                  <input
                    id="accentHex"
                    name="accentHex"
                    value={accent}
                    onChange={(event) => setAccent(event.target.value)}
                    // An example rather than "Nothing set": in a monospace hex
                    // field that phrase reads as a value.
                    placeholder={house.accentHex ?? '1F4E79'}
                    spellCheck={false}
                    className="h-10 w-32 rounded-lg border border-line bg-raised px-3 font-mono text-sm text-ink uppercase focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
                  />
                </div>

                <p className="mt-1.5 text-xs leading-relaxed text-ink-secondary">
                  {accent.trim() === ''
                    ? 'Empty prints black rules and black headings, as now.'
                    : !assessed.color
                      ? 'That is not six hex digits.'
                      : assessed.darkened
                        ? 'Rules and bars print in this colour. Headings print in a darker version of it — a bill of lading gets photocopied and faxed, and this one is too pale to survive that as text.'
                        : 'Used for the rules and for the document heading.'}
                </p>
              </div>

              <div>
                <label htmlFor="footerNote" className="text-sm font-medium text-ink">
                  Footer line
                </label>
                <input
                  id="footerNote"
                  name="footerNote"
                  defaultValue={values.footerNote ?? ''}
                  placeholder={
                    isHouse
                      ? 'Remit to PO Box 1180, Dalton GA 30722 · (706) 555-0142'
                      : placeholderFor('footerNote')
                  }
                  maxLength={110}
                  className="mt-2 h-10 w-full rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
                />
                <p className="mt-1.5 text-xs text-ink-muted">
                  One line at the bottom of every page, beside the page number. Replaces the
                  document number that prints there now.
                </p>
              </div>

              {REMIT_SCOPES.includes(scope) && (
                <div>
                  <label htmlFor="remitToText" className="text-sm font-medium text-ink">
                    Remittance block
                  </label>
                  <textarea
                    id="remitToText"
                    name="remitToText"
                    rows={3}
                    defaultValue={values.remitToText ?? ''}
                    placeholder={
                      isHouse
                        ? 'PO Box 1180\nDalton, GA 30722\nach@example.com'
                        : placeholderFor('remitToText')
                    }
                    maxLength={300}
                    className="mt-2 w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm leading-relaxed text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
                  />
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                    Replaces your office address under &ldquo;Remit to&rdquo; on invoices and credit
                    notes — for a lockbox that is not where you sit. Your name and authority numbers
                    stay: they are what identify the carrier claiming the money.
                  </p>
                </div>
              )}

              {ADDENDUM_SCOPES.includes(scope) ? (
                <div>
                  <label htmlFor="addendum" className="text-sm font-medium text-ink">
                    Your additional terms
                  </label>
                  <textarea
                    id="addendum"
                    name="addendum"
                    rows={6}
                    defaultValue={values.addendum ?? ''}
                    placeholder={
                      isHouse
                        ? 'Storage is charged at $50 per vehicle per day after 3 days at destination.'
                        : placeholderFor('addendum')
                    }
                    maxLength={4000}
                    className="mt-2 w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm leading-relaxed text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
                  />
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                    Printed after the fixed terms, under a heading naming you. It is appended, never
                    merged — a shipper reading the page has to be able to tell which sentences are
                    the regulation&rsquo;s and which are {legalName}&rsquo;s.
                  </p>
                </div>
              ) : (
                <p className="flex items-start gap-2 rounded-lg bg-surface px-3 py-2.5 text-xs leading-relaxed text-ink-secondary">
                  <Info className="mt-px size-3.5 shrink-0 text-ink-muted" aria-hidden />
                  {scope === 'claim'
                    ? 'No additional terms here. A claim letter says what 49 CFR Part 370 requires it to say, and a carrier’s standing terms have no business inside a claim disposition.'
                    : 'No additional terms here. A credit note corrects an invoice that already carried them, and restating them invites an argument about which document they attach to.'}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line px-5 py-4">
              {saved && (
                <p className="mr-auto flex items-center gap-1.5 text-xs text-ok">
                  <Check className="size-3.5" aria-hidden />
                  Saved
                </p>
              )}
              <Button
                type="button"
                variant="secondary"
                loading={previewing}
                onClick={() => void preview()}
              >
                <Eye aria-hidden />
                Preview a specimen
              </Button>
              <Button type="submit" loading={saving}>
                Save
              </Button>
            </div>
          </form>

          {previewUrl && (
            <div className="border-t border-line p-5">
              <p className="mb-3 text-xs leading-relaxed text-ink-secondary">
                Rendered through the same code a real document uses, with the values above — saved
                or not. Everything on it is marked SPECIMEN; nothing was stored.
              </p>
              <iframe
                src={previewUrl}
                title="Specimen document"
                className="h-[36rem] w-full rounded-lg border border-line bg-surface"
              />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
