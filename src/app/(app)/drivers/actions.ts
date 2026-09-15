'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  DRIVER_EMPLOYMENT_TYPES,
  drivers as driversTable,
  SETTLEMENT_LINE_KINDS,
  settlements as settlementsTable,
} from '@/lib/db/schema';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { parseMoney } from '@/lib/invoices/compute';
import {
  addLine,
  buildSettlement,
  driverEscrowBalance,
  finalizeSettlement,
  recordSettlementPayment,
  removeLine,
} from '@/lib/settlements/lifecycle';
import { buildStatement } from '@/lib/settlements/statement';

export interface DriverActionResult {
  ok: boolean;
  error?: string;
  driverId?: string;
  settlementId?: string;
  loadsIncluded?: number;
}

/* -------------------------------------------------------------------------
 * Drivers
 * ---------------------------------------------------------------------- */

const driverSchema = z.object({
  displayName: z.string().trim().min(1, 'Give the driver a name.').max(120),
  employmentType: z.enum(DRIVER_EMPLOYMENT_TYPES),
  cdlState: z.string().trim().max(2).optional(),
  cdlClass: z.enum(['A', 'B', 'C']).optional(),
  payRate: z.string().trim().optional(),
  payPerMile: z.string().trim().optional(),
});

export async function saveDriverAction(
  driverId: string | null,
  formData: FormData,
): Promise<DriverActionResult> {
  let context;
  try {
    context = await requireCapability('driver.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const cdlClass = formData.get('cdlClass');

  const parsed = driverSchema.safeParse({
    displayName: formData.get('displayName') ?? '',
    employmentType: formData.get('employmentType') ?? 'company',
    cdlState: formData.get('cdlState') ?? undefined,
    cdlClass: typeof cdlClass === 'string' && cdlClass !== '' ? cdlClass : undefined,
    payRate: formData.get('payRate') ?? undefined,
    payPerMile: formData.get('payPerMile') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details.' };
  }

  /*
   * A share is entered as a percentage and stored in basis points, so 68.5
   * becomes 6850 rather than losing the half point to an integer percentage.
   */
  let payRateBps: number | null = null;
  if (parsed.data.payRate && parsed.data.payRate.trim() !== '') {
    const percent = Number.parseFloat(parsed.data.payRate.replace('%', '').trim());
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return { ok: false, error: 'A pay share has to be a percentage between 0 and 100.' };
    }
    payRateBps = Math.round(percent * 100);
  }

  let payPerMileCents: number | null = null;
  if (parsed.data.payPerMile && parsed.data.payPerMile.trim() !== '') {
    payPerMileCents = parseMoney(parsed.data.payPerMile);
    if (payPerMileCents === null) {
      return { ok: false, error: `“${parsed.data.payPerMile}” is not an amount.` };
    }
  }

  const { session, db } = context;

  const values = {
    displayName: parsed.data.displayName,
    employmentType: parsed.data.employmentType,
    cdlState: parsed.data.cdlState?.toUpperCase() || null,
    cdlClass: parsed.data.cdlClass ?? null,
    payRateBps,
    payPerMileCents,
  };

  if (driverId) {
    await db.update('drivers', eq(driversTable.id, driverId), values);
    revalidatePath('/drivers');
    return { ok: true, driverId };
  }

  const [created] = await db.insert('drivers', { ...values, activeAt: new Date() });
  if (!created) return { ok: false, error: 'The driver could not be saved.' };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.driverCreated,
    subject: `driver:${created.id}`,
    detail: { displayName: values.displayName, employmentType: values.employmentType },
  });

  revalidatePath('/drivers');
  return { ok: true, driverId: created.id };
}

/* -------------------------------------------------------------------------
 * Settlements
 * ---------------------------------------------------------------------- */

const periodSchema = z.object({
  periodStart: z.string().trim().min(1, 'Set the start of the pay period.'),
  periodEnd: z.string().trim().min(1, 'Set the end of the pay period.'),
});

/** Dates are calendar dates; pinned to noon UTC so no offset moves the day. */
function atNoon(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function buildSettlementAction(
  driverId: string,
  formData: FormData,
): Promise<DriverActionResult> {
  let context;
  try {
    context = await requireCapability('settlement.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = periodSchema.safeParse({
    periodStart: formData.get('periodStart') ?? '',
    periodEnd: formData.get('periodEnd') ?? '',
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Set the pay period.' };
  }

  const start = atNoon(parsed.data.periodStart);
  const end = atNoon(parsed.data.periodEnd);
  if (!start || !end) return { ok: false, error: 'Those are not dates.' };

  const result = await buildSettlement(context.db, driverId, start, end);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath('/drivers');
  return { ok: true, settlementId: result.settlementId, loadsIncluded: result.loadsIncluded };
}

const lineSchema = z.object({
  kind: z.enum(SETTLEMENT_LINE_KINDS),
  description: z.string().trim().min(1, 'Say what the line is for.').max(200),
  amount: z.string().trim().min(1, 'Enter an amount.'),
  basisNote: z.string().trim().max(200).optional(),
});

export async function addLineAction(
  settlementId: string,
  formData: FormData,
): Promise<DriverActionResult> {
  let context;
  try {
    context = await requireCapability('settlement.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = lineSchema.safeParse({
    kind: formData.get('kind') ?? 'deduction',
    description: formData.get('description') ?? '',
    amount: formData.get('amount') ?? '',
    basisNote: formData.get('basisNote') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the line.' };
  }

  const amountCents = parseMoney(parsed.data.amount);
  if (amountCents === null) {
    return { ok: false, error: `“${parsed.data.amount}” is not an amount.` };
  }

  const result = await addLine(context.db, settlementId, {
    kind: parsed.data.kind,
    description: parsed.data.description,
    amountCents,
    basisNote: parsed.data.basisNote || null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/settlements/${settlementId}`);
  return { ok: true, settlementId };
}

export async function removeLineAction(
  settlementId: string,
  lineId: string,
): Promise<DriverActionResult> {
  let context;
  try {
    context = await requireCapability('settlement.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const result = await removeLine(context.db, settlementId, lineId);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/settlements/${settlementId}`);
  return { ok: true, settlementId };
}

export async function finalizeSettlementAction(
  settlementId: string,
): Promise<DriverActionResult> {
  let context;
  try {
    context = await requireCapability('settlement.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;

  const result = await finalizeSettlement(db, settlementId);
  if (!result.ok) return { ok: false, error: result.error };

  // The statement is produced after finalising, so the bytes handed over are
  // the frozen figures rather than a draft that moved afterwards.
  const statement = await buildStatement(db, settlementId);
  if (!statement.ok) return { ok: false, error: statement.error };

  const settlement = await db.selectOne('settlements', eq(settlementsTable.id, settlementId));

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.settlementFinalized,
    subject: `settlement:${settlementId}`,
    detail: {
      driverId: settlement?.driverId,
      netPayCents: settlement?.netPayCents,
      documentId: statement.documentId,
      sha256: statement.sha256,
    },
  });

  revalidatePath(`/settlements/${settlementId}`);
  revalidatePath('/drivers');
  revalidatePath('/documents');

  return { ok: true, settlementId };
}

const paymentSchema = z.object({
  reference: z.string().trim().max(80).optional(),
  paidAt: z.string().trim().optional(),
});

export async function paySettlementAction(
  settlementId: string,
  formData: FormData,
): Promise<DriverActionResult> {
  let context;
  try {
    context = await requireCapability('settlement.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = paymentSchema.safeParse({
    reference: formData.get('reference') ?? undefined,
    paidAt: formData.get('paidAt') ?? undefined,
  });

  if (!parsed.success) return { ok: false, error: 'Check the payment details.' };

  const paidAt = parsed.data.paidAt ? atNoon(parsed.data.paidAt) : new Date();
  if (!paidAt) return { ok: false, error: 'That is not a date.' };

  const { session, db } = context;

  const result = await recordSettlementPayment(
    db,
    settlementId,
    parsed.data.reference || null,
    paidAt,
  );
  if (!result.ok) return { ok: false, error: result.error };

  const settlement = await db.selectOne('settlements', eq(settlementsTable.id, settlementId));

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.settlementPaid,
    subject: `settlement:${settlementId}`,
    detail: {
      driverId: settlement?.driverId,
      netPayCents: settlement?.netPayCents,
      reference: parsed.data.reference ?? null,
      paidAt: paidAt.toISOString(),
    },
  });

  revalidatePath(`/settlements/${settlementId}`);
  revalidatePath('/drivers');

  return { ok: true, settlementId };
}

/** Escrow held for a driver across every settlement, for the drivers screen. */
export async function escrowFor(driverId: string): Promise<number> {
  try {
    const { db } = await requireCapability('settlement.read');
    return await driverEscrowBalance(db, driverId);
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------
 * Leaving
 * ---------------------------------------------------------------------- */

/**
 * Records that a driver has gone.
 *
 * Nothing else in the data says a lease ended, and two clocks start from this
 * date: the forty-five days 49 CFR 376.12(h) allows for returning escrow, and
 * the retention period after which the driver record itself becomes
 * purgeable. So it is a deliberate act with its own audit entry rather than a
 * field buried in the edit form, where it would be changed by accident and
 * noticed by nobody.
 *
 * `driver.write`, which is owner-only. Starting a legal clock and making a
 * personnel record destroyable is not a dispatch decision.
 */
export async function endLeaseAction(driverId: string): Promise<DriverActionResult> {
  let context;
  try {
    context = await requireCapability('driver.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;

  const driver = await db.selectOne('drivers', eq(driversTable.id, driverId));
  if (!driver) return { ok: false, error: 'No such driver.' };
  if (driver.deactivatedAt) return { ok: false, error: 'That driver has already left.' };

  const left = new Date();
  await db.update('drivers', eq(driversTable.id, driverId), { deactivatedAt: left });

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.driverLeft,
    subject: `driver:${driverId}`,
    detail: { employmentType: driver.employmentType, leftOn: left.toISOString() },
  });

  revalidatePath('/drivers');
  revalidatePath('/dashboard');
  return { ok: true };
}

/**
 * Undoes it.
 *
 * A misclick here would otherwise start a statutory clock against a driver who
 * never left and, forty-five days later, put a warning on the dashboard about
 * money nobody owes back yet. Both the act and its reversal are audited, so
 * the record shows a date that moved rather than a date that was always wrong.
 */
export async function reinstateDriverAction(driverId: string): Promise<DriverActionResult> {
  let context;
  try {
    context = await requireCapability('driver.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;

  const driver = await db.selectOne('drivers', eq(driversTable.id, driverId));
  if (!driver) return { ok: false, error: 'No such driver.' };
  if (!driver.deactivatedAt) return { ok: false, error: 'That driver has not left.' };

  await db.update('drivers', eq(driversTable.id, driverId), {
    deactivatedAt: null,
    activeAt: driver.activeAt ?? new Date(),
  });

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.driverReinstated,
    subject: `driver:${driverId}`,
    detail: { hadLeftOn: driver.deactivatedAt.toISOString() },
  });

  revalidatePath('/drivers');
  revalidatePath('/dashboard');
  return { ok: true };
}
