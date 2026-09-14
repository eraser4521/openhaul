import 'server-only';
import { eq } from 'drizzle-orm';
import { rgb } from 'pdf-lib';
import {
  documentTemplates,
  type DocumentKind,
  type DocumentTemplate,
  type TemplateScope,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { blobStore } from '../storage/blob-store';
import type { DocumentBrand } from '../documents/layout';
import { assessAccent, type Rgb } from './color';

/**
 * Resolving a carrier's template into something a renderer can use.
 *
 * Two rules hold this together.
 *
 * The first is that null means inherit. A carrier sets a house style once on
 * the `all` row and then overrides only the handful of fields that differ on
 * an invoice, so every field resolves as "this scope, else the house, else
 * nothing". Nothing is copied down at write time, which means correcting the
 * house style corrects every document that was inheriting it.
 *
 * The second is that an unconfigured carrier gets no brand at all — not an
 * empty one. `brandFor` returns null rather than a struct of nulls, so a
 * document from an instance nobody has customised renders through exactly the
 * code path it rendered through before this feature existed.
 *
 * Changing a template never reaches a document that has already been issued.
 * The PDF is frozen at the byte level when it is created, so a logo replaced
 * in March does not appear on a bill of lading signed in February — which is
 * the behaviour the record-retention rules require and the opposite of what a
 * live template would do.
 */

/** The logo lives on the house row. Nobody needs a different logo per document. */
const LOGO_SCOPE: TemplateScope = 'all';

export interface TemplateFields {
  letterheadName: string | null;
  tagline: string | null;
  accentHex: string | null;
  showLogo: boolean | null;
  footerNote: string | null;
  addendum: string | null;
  remitToText: string | null;
}

export interface ResolvedTemplate extends TemplateFields {
  logoStorageKey: string | null;
  logoSha256: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
  /** True when at least one field anywhere in the chain is set. */
  configured: boolean;
}

/** Which template a given document kind reads. */
export function scopeForKind(kind: DocumentKind): TemplateScope {
  switch (kind) {
    case 'bol':
      return 'bol';
    case 'pod':
      return 'pod';
    case 'invoice':
      return 'invoice';
    case 'credit_note':
      return 'credit_note';
    case 'settlement':
      return 'settlement';
    case 'claim_acknowledgement':
    case 'claim_status':
    case 'claim_disposition':
      // One scope for all three: they are the same letter at three stages of
      // the same claim, and nobody wants different letterhead between them.
      return 'claim';
    default:
      return 'all';
  }
}

export async function templateRow(
  scoped: ScopedDb,
  scope: TemplateScope,
): Promise<DocumentTemplate | null> {
  return scoped.selectOne('documentTemplates', eq(documentTemplates.scope, scope));
}

export async function allTemplates(scoped: ScopedDb): Promise<DocumentTemplate[]> {
  return scoped.select('documentTemplates');
}

/** First non-null down the chain; null when nothing set it. */
function inherit<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export async function resolveTemplate(
  scoped: ScopedDb,
  scope: TemplateScope,
): Promise<ResolvedTemplate> {
  const rows = await allTemplates(scoped);
  const house = rows.find((row) => row.scope === LOGO_SCOPE) ?? null;
  const specific = scope === LOGO_SCOPE ? null : (rows.find((row) => row.scope === scope) ?? null);

  const resolved: Omit<ResolvedTemplate, 'configured'> = {
    letterheadName: inherit(specific?.letterheadName, house?.letterheadName),
    tagline: inherit(specific?.tagline, house?.tagline),
    accentHex: inherit(specific?.accentHex, house?.accentHex),
    showLogo: inherit(specific?.showLogo, house?.showLogo),
    footerNote: inherit(specific?.footerNote, house?.footerNote),
    addendum: inherit(specific?.addendum, house?.addendum),
    remitToText: inherit(specific?.remitToText, house?.remitToText),
    logoStorageKey: house?.logoStorageKey ?? null,
    logoSha256: house?.logoSha256 ?? null,
    logoWidth: house?.logoWidth ?? null,
    logoHeight: house?.logoHeight ?? null,
  };

  const configured = Object.values(resolved).some((value) => value !== null);
  return { ...resolved, configured };
}

function toRgb(color: Rgb) {
  return rgb(color.r / 255, color.g / 255, color.b / 255);
}

/**
 * Everything a renderer needs, with the logo bytes already fetched.
 *
 * A missing or unreadable logo blob degrades to no logo rather than failing
 * the render. A carrier signing a bill of lading at a terminal gate should not
 * be stopped by a file that went missing from the uploads directory; the
 * document is still valid without their logo on it, and it is not.
 */
export async function brandFor(
  scoped: ScopedDb,
  kind: DocumentKind,
): Promise<DocumentBrand | null> {
  const template = await resolveTemplate(scoped, scopeForKind(kind));
  if (!template.configured) return null;
  return brandFrom(template);
}

/**
 * Builds a brand from fields that may not be saved yet.
 *
 * The preview needs this: a carrier has to be able to see what a colour does
 * to a bill of lading before committing it to one, and the only way to show
 * that honestly is to render through the same path the real document takes.
 */
export async function brandFrom(template: ResolvedTemplate): Promise<DocumentBrand> {
  let logo: DocumentBrand['logo'] = null;
  if (template.showLogo !== false && template.logoStorageKey) {
    const bytes = await blobStore()
      .get(template.logoStorageKey)
      .catch(() => null);

    if (bytes && template.logoWidth && template.logoHeight) {
      logo = {
        bytes,
        // Uploads are normalised to PNG on the way in, so nothing else can be
        // in the store under a logo key.
        contentType: 'image/png',
        width: template.logoWidth,
        height: template.logoHeight,
      };
    }
  }

  const accent = assessAccent(template.accentHex);

  return {
    name: template.letterheadName,
    tagline: template.tagline,
    logo,
    accent: accent.color ? toRgb(accent.color) : null,
    accentText: accent.textColor ? toRgb(accent.textColor) : null,
    footerNote: template.footerNote,
    addendum: template.addendum,
    remitToText: template.remitToText,
  };
}

/**
 * Writes one scope's row, creating it the first time.
 *
 * Fields left undefined are untouched; fields set to null are cleared back to
 * inheriting. The distinction matters because "clear the footer on invoices"
 * and "leave the footer alone" are different edits and the form sends both.
 */
export async function saveTemplate(
  scoped: ScopedDb,
  scope: TemplateScope,
  fields: Partial<TemplateFields>,
): Promise<void> {
  const existing = await templateRow(scoped, scope);

  if (existing) {
    await scoped.update('documentTemplates', eq(documentTemplates.id, existing.id), fields);
    return;
  }

  await scoped.insert('documentTemplates', { scope, ...fields });
}

export interface LogoRecord {
  storageKey: string;
  sha256: string;
  width: number;
  height: number;
}

export async function setLogo(scoped: ScopedDb, logo: LogoRecord): Promise<void> {
  const existing = await templateRow(scoped, LOGO_SCOPE);
  const values = {
    logoStorageKey: logo.storageKey,
    logoSha256: logo.sha256,
    logoWidth: logo.width,
    logoHeight: logo.height,
  };

  if (existing) {
    await scoped.update('documentTemplates', eq(documentTemplates.id, existing.id), values);
    return;
  }

  await scoped.insert('documentTemplates', { scope: LOGO_SCOPE, ...values });
}

/**
 * Forgets the logo without deleting the blob.
 *
 * The bytes are content-addressed and every document already rendered with
 * that logo embedded a copy of them, so there is nothing to reclaim by
 * deleting and a real risk in trying.
 */
export async function clearLogo(scoped: ScopedDb): Promise<void> {
  const existing = await templateRow(scoped, LOGO_SCOPE);
  if (!existing) return;

  await scoped.update('documentTemplates', eq(documentTemplates.id, existing.id), {
    logoStorageKey: null,
    logoSha256: null,
    logoWidth: null,
    logoHeight: null,
  });
}
