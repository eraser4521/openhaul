import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requireCapability } from '@/lib/auth/guard';
import { getOrganization } from '@/lib/organization/profile';
import { brandFrom, resolveTemplate, type ResolvedTemplate } from '@/lib/branding/template';
import { renderSpecimen } from '@/lib/branding/preview';
import { templateFieldsSchema, templateScopeSchema } from '@/lib/branding/validate';

/**
 * A specimen document from values that have not been saved.
 *
 * The point of the whole feature is that a carrier's paperwork looks like
 * theirs, and there is no way to judge that from a colour swatch. So the
 * preview renders through the real renderers with the values currently in the
 * form, and nothing is written — a carrier can try six colours against a bill
 * of lading without leaving a trace of the five they rejected.
 *
 * POST rather than GET because the unsaved form goes in the body. It changes
 * nothing, but a URL long enough to carry an addendum is not a URL.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const requestSchema = z.object({
  scope: templateScopeSchema,
  fields: templateFieldsSchema,
});

export async function POST(request: Request) {
  let auth;
  try {
    auth = await requireCapability('settings.write');
  } catch (error) {
    const status = error instanceof AuthError && error.kind === 'forbidden' ? 403 : 401;
    return NextResponse.json({ error: 'Only an owner can change the letterhead.' }, { status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Check the values.' },
      { status: 400 },
    );
  }

  const { scope, fields } = parsed.data;

  const org = await getOrganization(auth.session.orgId);
  if (!org) return NextResponse.json({ error: 'No organisation record.' }, { status: 404 });

  /*
   * Unsaved values sit on top of what is saved, and a field the form left
   * empty still inherits from the house style — exactly as it would once
   * saved. Previewing through a different resolution path than the real
   * document uses would make the preview a lie in the one case it matters.
   */
  const house = await resolveTemplate(auth.db, 'all');
  const inheritFrom = scope === 'all' ? null : house;

  const template: ResolvedTemplate = {
    letterheadName: fields.letterheadName ?? inheritFrom?.letterheadName ?? null,
    tagline: fields.tagline ?? inheritFrom?.tagline ?? null,
    accentHex: fields.accentHex ?? inheritFrom?.accentHex ?? null,
    showLogo: fields.showLogo ?? inheritFrom?.showLogo ?? null,
    footerNote: fields.footerNote ?? inheritFrom?.footerNote ?? null,
    addendum: fields.addendum ?? inheritFrom?.addendum ?? null,
    remitToText: fields.remitToText ?? inheritFrom?.remitToText ?? null,
    // The logo always lives on the house row and is never part of the form
    // body, so it comes from storage whatever scope is being previewed.
    logoStorageKey: house.logoStorageKey,
    logoSha256: house.logoSha256,
    logoWidth: house.logoWidth,
    logoHeight: house.logoHeight,
    configured: true,
  };

  const bytes = await renderSpecimen(scope, org, await brandFrom(template));

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
      'content-disposition': 'inline; filename="specimen.pdf"',
      'x-content-type-options': 'nosniff',
    },
  });
}
