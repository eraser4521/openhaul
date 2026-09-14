import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyMigrations } from './helpers/temp-db';

/**
 * Templates and the accessorial catalogue, against a real database.
 *
 * Two behaviours need one: that null genuinely means inherit rather than
 * "clear", and that a line on an invoice keeps saying what it said after the
 * catalogue behind it moves on. Both are about time — what a template said
 * when a document was made versus what it says now — and neither can be
 * checked without writing and reading back.
 */

let workspace: string;
let scoped: Awaited<ReturnType<typeof import('@/lib/db/scope')['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let template: typeof import('@/lib/branding/template');
let accessorials: typeof import('@/lib/branding/accessorials');

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-template-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  template = await import('@/lib/branding/template');
  accessorials = await import('@/lib/branding/accessorials');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({ legalName: 'Ridgeline Auto Transport LLC' })
    .returning();
  scoped = forOrg(asOrgId(org!.id));
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

describe('resolving a template', () => {
  it('gives an unconfigured carrier no brand at all', async () => {
    const resolved = await template.resolveTemplate(scoped, 'invoice');
    expect(resolved.configured).toBe(false);
    expect(resolved.accentHex).toBeNull();

    // Not an empty brand — null, so the renderer takes the path it took
    // before templates existed.
    expect(await template.brandFor(scoped, 'invoice')).toBeNull();
  });

  it('inherits the house style everywhere once it is set', async () => {
    await template.saveTemplate(scoped, 'all', {
      letterheadName: 'RIDGELINE',
      tagline: 'Enclosed auto transport since 2011',
      accentHex: '1f4e79',
      footerNote: 'Dispatch (817) 555-0142',
    });

    for (const scope of ['bol', 'invoice', 'claim'] as const) {
      const resolved = await template.resolveTemplate(scoped, scope);
      expect(resolved.letterheadName).toBe('RIDGELINE');
      expect(resolved.accentHex).toBe('1f4e79');
      expect(resolved.footerNote).toBe('Dispatch (817) 555-0142');
      expect(resolved.configured).toBe(true);
    }
  });

  it('overrides only the fields a scope actually sets', async () => {
    await template.saveTemplate(scoped, 'invoice', {
      footerNote: 'Remit to PO Box 1180, Dalton GA 30722',
    });

    const invoice = await template.resolveTemplate(scoped, 'invoice');
    expect(invoice.footerNote).toBe('Remit to PO Box 1180, Dalton GA 30722');
    // Everything it did not set still comes from the house.
    expect(invoice.letterheadName).toBe('RIDGELINE');
    expect(invoice.accentHex).toBe('1f4e79');

    const bol = await template.resolveTemplate(scoped, 'bol');
    expect(bol.footerNote).toBe('Dispatch (817) 555-0142');
  });

  it('clears a field back to inheriting when it is set to null', async () => {
    /*
     * "Clear the footer on invoices" and "leave the footer alone" are
     * different edits, and the form sends both. Null has to mean the first and
     * undefined the second, or a carrier cannot undo an override.
     */
    await template.saveTemplate(scoped, 'invoice', { footerNote: null });

    const invoice = await template.resolveTemplate(scoped, 'invoice');
    expect(invoice.footerNote).toBe('Dispatch (817) 555-0142');

    // Restored for the tests below.
    await template.saveTemplate(scoped, 'invoice', {
      footerNote: 'Remit to PO Box 1180, Dalton GA 30722',
    });
  });

  it('lets one document turn the logo off without turning it off everywhere', async () => {
    await template.setLogo(scoped, {
      storageKey: 'branding/aa/bb/logo.png',
      sha256: 'b'.repeat(64),
      width: 240,
      height: 60,
    });
    await template.saveTemplate(scoped, 'settlement', { showLogo: false });

    expect((await template.resolveTemplate(scoped, 'bol')).showLogo).toBeNull();
    expect((await template.resolveTemplate(scoped, 'settlement')).showLogo).toBe(false);

    // The logo itself lives on the house row and is visible from every scope.
    expect((await template.resolveTemplate(scoped, 'invoice')).logoStorageKey).toBe(
      'branding/aa/bb/logo.png',
    );
  });

  it('degrades to no logo when the stored bytes have gone missing', async () => {
    // A file lost from the uploads directory must not stop a driver signing a
    // bill of lading at a terminal gate. The document is valid without it.
    const brand = await template.brandFor(scoped, 'bol');
    expect(brand).not.toBeNull();
    expect(brand?.logo).toBeNull();
    expect(brand?.name).toBe('RIDGELINE');
  });

  it('darkens a pale accent for text while leaving the rule colour alone', async () => {
    await template.saveTemplate(scoped, 'all', { accentHex: 'f59e0b' });

    const brand = await template.brandFor(scoped, 'bol');
    expect(brand?.accent).not.toBeNull();
    expect(brand?.accentText).not.toBeNull();
    // Same hue, but the text version is darker.
    expect(brand!.accentText!.red).toBeLessThan(brand!.accent!.red);

    await template.saveTemplate(scoped, 'all', { accentHex: '1f4e79' });
  });

  it('sends all three Part 370 letters to one template', () => {
    expect(template.scopeForKind('claim_acknowledgement')).toBe('claim');
    expect(template.scopeForKind('claim_status')).toBe('claim');
    expect(template.scopeForKind('claim_disposition')).toBe('claim');
    expect(template.scopeForKind('bol')).toBe('bol');
    expect(template.scopeForKind('w9')).toBe('all');
  });
});

describe('the accessorial catalogue', () => {
  it('refuses a second charge under the same code', async () => {
    const first = await accessorials.createRate(scoped, {
      code: 'det',
      label: 'Detention at pickup',
      unit: 'per_hour',
      defaultCents: 7_500,
      note: null,
    });
    expect(first.ok).toBe(true);

    const second = await accessorials.createRate(scoped, {
      code: 'DET',
      label: 'Waiting time',
      unit: 'per_hour',
      defaultCents: 8_000,
      note: null,
    });

    // The same charge under two names is the thing a broker queries, which is
    // the whole reason for a catalogue.
    expect(second.ok).toBe(false);
    expect(second.error).toContain('DET');
  });

  it('retires a charge rather than deleting it', async () => {
    const created = await accessorials.createRate(scoped, {
      code: 'OLD',
      label: 'Something no longer billed',
      unit: 'flat',
      defaultCents: 1_000,
      note: null,
    });

    await accessorials.setRateActive(scoped, created.id!, false);

    const live = await accessorials.listRates(scoped);
    const all = await accessorials.listRates(scoped, { includeRetired: true });

    expect(live.map((rate) => rate.code)).not.toContain('OLD');
    expect(all.map((rate) => rate.code)).toContain('OLD');
  });
});

describe('itemised accessorials on an invoice', () => {
  let invoiceId: string;
  let rateId: string;

  beforeAll(async () => {
    const [invoice] = await scoped.insert('invoices', {
      number: 'INV-OH-2001',
      status: 'draft',
      lineHaulCents: 95_000,
      fuelSurchargeCents: 0,
      accessorialCents: 0,
      taxCents: 0,
      codCollectedCents: 0,
      depositCents: 0,
      totalCents: 95_000,
    });
    invoiceId = invoice!.id;

    rateId = (await accessorials.listRates(scoped)).find((rate) => rate.code === 'DET')!.id;
  });

  it('derives the invoice total from the lines', async () => {
    const added = await accessorials.addAccessorial(scoped, invoiceId, {
      rateId,
      label: 'Detention at pickup',
      code: 'DET',
      unit: 'per_hour',
      quantityHundredths: 350,
      unitCents: 7_500,
      note: null,
    });
    expect(added.ok).toBe(true);

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.accessorialCents).toBe(26_250);
    expect(invoice?.totalCents).toBe(121_250);
  });

  it('leaves the line alone when the catalogue rate changes afterwards', async () => {
    /*
     * The customer is holding an invoice stating a figure. A rate rise next
     * month cannot reach back and change what was charged last month, so the
     * line carries its own copy of the label and the rate.
     */
    await accessorials.updateRate(scoped, rateId, {
      label: 'Detention (revised)',
      defaultCents: 9_500,
    });

    const [line] = await accessorials.accessorialsFor(scoped, invoiceId);
    expect(line?.label).toBe('Detention at pickup');
    expect(line?.unitCents).toBe(7_500);
    expect(line?.amountCents).toBe(26_250);
  });

  it('re-derives rather than adjusting when a line is removed', async () => {
    const extra = await accessorials.addAccessorial(scoped, invoiceId, {
      rateId: null,
      label: 'Winch out',
      code: 'win',
      unit: 'flat',
      quantityHundredths: 100,
      unitCents: 22_500,
      note: null,
    });

    let invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.accessorialCents).toBe(48_750);

    await accessorials.removeAccessorial(scoped, invoiceId, extra.id!);

    invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    // Back exactly where it started, which an accumulated column would not be.
    expect(invoice?.accessorialCents).toBe(26_250);
    expect(invoice?.totalCents).toBe(121_250);
  });

  it('uppercases a typed code so the same charge sorts together', async () => {
    const lines = await accessorials.accessorialsFor(scoped, invoiceId);
    expect(lines.every((line) => line.code === null || line.code === line.code.toUpperCase())).toBe(
      true,
    );
  });

  it('refuses a charge once the invoice has been issued', async () => {
    await scoped.update('invoices', eq(schema.invoices.id, invoiceId), {
      status: 'sent',
      issuedAt: new Date(),
    });

    const result = await accessorials.addAccessorial(scoped, invoiceId, {
      rateId: null,
      label: 'Late thought',
      code: null,
      unit: 'flat',
      quantityHundredths: 100,
      unitCents: 5_000,
      note: null,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('second invoice');

    // And the figures did not move.
    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.accessorialCents).toBe(26_250);
  });

  it('refuses a quantity of nothing', async () => {
    const [draft] = await scoped.insert('invoices', {
      number: 'INV-OH-2002',
      status: 'draft',
      totalCents: 0,
    });

    const result = await accessorials.addAccessorial(scoped, draft!.id, {
      rateId: null,
      label: 'Nothing at all',
      code: null,
      unit: 'per_hour',
      quantityHundredths: 0,
      unitCents: 7_500,
      note: null,
    });

    expect(result.ok).toBe(false);
  });

  it('will not remove a line by quoting the wrong invoice', async () => {
    const [other] = await scoped.insert('invoices', {
      number: 'INV-OH-2003',
      status: 'draft',
      totalCents: 0,
    });

    const [line] = await accessorials.accessorialsFor(scoped, invoiceId);
    const result = await accessorials.removeAccessorial(scoped, other!.id, line!.id);

    expect(result.ok).toBe(false);
    expect((await accessorials.accessorialsFor(scoped, invoiceId)).length).toBe(1);
  });
});
