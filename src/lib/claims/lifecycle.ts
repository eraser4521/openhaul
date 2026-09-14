import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  claims as claimsTable,
  customers as customersTable,
  damages as damagesTable,
  documents as documentsTable,
  inspections as inspectionsTable,
  inspectionPhotos as photosTable,
  loads as loadsTable,
  vehicles as vehiclesTable,
  type ClaimStatus,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { getOrganization } from '../organization/profile';
import { storeDocument } from '../documents/store';
import { holdOnLoad, placeHold, releaseHolds } from '../retention/holds';
import { brandFor } from '../branding/template';
import {
  claimLetterTitle,
  renderClaimLetter,
  type ClaimLetterKind,
  type Disposition,
} from '../documents/claim-letter';
import { claimClock, isLateFiled, nextStatusLetterDue } from './deadlines';
import { assessPrimaFacie, type PrimaFacieAssessment } from './validity';

/**
 * The claim workflow.
 *
 * A claim is a file, not a record: the statutory clocks, the letters that
 * answer them, and the inspection evidence that decides the thing. The
 * lifecycle keeps the three in step, because the common failure is not a wrong
 * decision — it is a right decision taken after the deadline for taking it.
 */

/* -------------------------------------------------------------------------
 * Numbering
 * ---------------------------------------------------------------------- */

/**
 * Claim numbers are sequential per organisation and per year.
 *
 * Not derived from the load, unlike an invoice: several vehicles on one load
 * can each be claimed separately, and a claimant quoting "the claim on load
 * OH-1001" would be ambiguous exactly when it matters.
 */
export function nextClaimNumber(year: number, taken: ReadonlySet<string>): string {
  const prefix = `CLM-${year}-`;

  let highest = 0;
  for (const number of taken) {
    if (!number.startsWith(prefix)) continue;
    const sequence = Number.parseInt(number.slice(prefix.length), 10);
    if (Number.isFinite(sequence) && sequence > highest) highest = sequence;
  }

  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
}

/* -------------------------------------------------------------------------
 * Filing
 * ---------------------------------------------------------------------- */

export interface FileClaimInput {
  loadId: string | null;
  vehicleId: string | null;
  claimantName: string;
  claimantEmail: string | null;
  demandAmountCents: number | null;
  description: string;
  /** The date the written claim was received, which is what the clocks run from. */
  filedAt: Date;

  /** Who filed it, recorded against the legal hold this places on the load. */
  actorUserId?: string | null;
  actorRole?: string | null;
}

export interface FileClaimResult {
  ok: boolean;
  claimId?: string;
  number?: string;
  lateFiled?: boolean;
  error?: string;
}

export async function fileClaim(
  scoped: ScopedDb,
  input: FileClaimInput,
): Promise<FileClaimResult> {
  if (!input.claimantName.trim()) {
    return { ok: false, error: 'A claim has to name who is making it.' };
  }
  if (!input.description.trim()) {
    return { ok: false, error: 'Record what is being claimed.' };
  }

  const load = input.loadId
    ? await scoped.selectOne('loads', eq(loadsTable.id, input.loadId))
    : null;

  if (input.loadId && !load) return { ok: false, error: 'No such load.' };

  const existing = await scoped.select('claims');
  const number = nextClaimNumber(
    input.filedAt.getUTCFullYear(),
    new Set(existing.map((claim) => claim.number)),
  );

  const { acknowledgeDueAt, resolveDueAt } = claimClock(input.filedAt);

  const [created] = await scoped.insert('claims', {
    number,
    loadId: input.loadId,
    vehicleId: input.vehicleId,
    customerId: load?.customerId ?? null,
    status: 'filed',
    claimantName: input.claimantName.trim(),
    claimantEmail: input.claimantEmail,
    demandAmountCents: input.demandAmountCents,
    description: input.description.trim(),
    filedAt: input.filedAt,
    acknowledgeDueAt,
    resolveDueAt,
    // Only owed once the claim is still open at 120 days, so it starts unset
    // and is filled in when the acknowledgement goes out.
    nextStatusDueAt: null,
  });

  if (!created) return { ok: false, error: 'The claim could not be filed.' };

  /*
   * A load under claim must not have its records aged out from under it. The
   * legal hold is set here rather than at disposition because the retention
   * sweep does not know a claim is coming.
   */
  if (input.loadId) {
    await placeHold(
      scoped,
      holdOnLoad(input.loadId),
      `Cargo claim ${number} filed by ${input.claimantName.trim()}`,
      { userId: input.actorUserId ?? null, role: input.actorRole ?? null },
    );
  }

  return {
    ok: true,
    claimId: created.id,
    number,
    lateFiled: isLateFiled(input.filedAt, load?.deliveredAt ?? null),
  };
}

/* -------------------------------------------------------------------------
 * Evidence
 * ---------------------------------------------------------------------- */

export interface ClaimEvidence {
  assessment: PrimaFacieAssessment;
  originPhotos: Array<{ id: string; slot: string | null; storageKey: string }>;
  destinationPhotos: Array<{ id: string; slot: string | null; storageKey: string }>;
  originInspectionId: string | null;
  destinationInspectionId: string | null;
  documents: Array<{ id: string; kind: string; title: string; sha256: string }>;
  vehicle: { vin: string; description: string } | null;
  deliveredAt: Date | null;
}

/**
 * Assembles the file.
 *
 * Under Carmack a shipper makes its case by showing good condition at origin,
 * damaged condition at destination, and the amount. The inspection record was
 * built to produce exactly those, so this puts the two ends side by side and
 * names what is missing rather than leaving someone to go looking through
 * screens under time pressure.
 */
export async function claimEvidence(
  scoped: ScopedDb,
  claimId: string,
): Promise<ClaimEvidence | { error: string }> {
  const claim = await scoped.selectOne('claims', eq(claimsTable.id, claimId));
  if (!claim) return { error: 'No such claim.' };

  const load = claim.loadId
    ? await scoped.selectOne('loads', eq(loadsTable.id, claim.loadId))
    : null;

  const vehicle = claim.vehicleId
    ? await scoped.selectOne('vehicles', eq(vehiclesTable.id, claim.vehicleId))
    : null;

  const inspectionsFor = async (stage: 'pickup' | 'delivery') => {
    if (!vehicle) return null;
    const [inspection] = await scoped.select(
      'inspections',
      and(eq(inspectionsTable.vehicleId, vehicle.id), eq(inspectionsTable.stage, stage)),
    );
    return inspection ?? null;
  };

  const [origin, destination] = await Promise.all([
    inspectionsFor('pickup'),
    inspectionsFor('delivery'),
  ]);

  const detailFor = async (inspectionId: string | null) => {
    if (!inspectionId) return { damages: [], photos: [] };
    const [damages, photos] = await Promise.all([
      scoped.select('damages', eq(damagesTable.inspectionId, inspectionId)),
      scoped.select('inspectionPhotos', eq(photosTable.inspectionId, inspectionId)),
    ]);
    return { damages, photos };
  };

  const [originDetail, destinationDetail] = await Promise.all([
    detailFor(origin?.id ?? null),
    detailFor(destination?.id ?? null),
  ]);

  const issued = claim.loadId
    ? await scoped.select('documents', eq(documentsTable.loadId, claim.loadId))
    : [];

  // Superseded copies are retained but are not the ones a claim turns on.
  const superseded = new Set(
    issued.map((d) => d.supersedesDocumentId).filter((id): id is string => id !== null),
  );

  return {
    assessment: assessPrimaFacie({
      originDamages: originDetail.damages,
      destinationDamages: destinationDetail.damages,
      originPhotoCount: originDetail.photos.length,
      destinationPhotoCount: destinationDetail.photos.length,
      originSealed: origin?.finalizedAt != null,
      destinationSealed: destination?.finalizedAt != null,
    }),
    originPhotos: originDetail.photos.map((photo) => ({
      id: photo.id,
      slot: photo.slot,
      storageKey: photo.storageKey,
    })),
    destinationPhotos: destinationDetail.photos.map((photo) => ({
      id: photo.id,
      slot: photo.slot,
      storageKey: photo.storageKey,
    })),
    originInspectionId: origin?.id ?? null,
    destinationInspectionId: destination?.id ?? null,
    documents: issued
      .filter((document) => !superseded.has(document.id))
      .map((document) => ({
        id: document.id,
        kind: document.kind,
        title: document.title,
        sha256: document.sha256,
      })),
    vehicle: vehicle
      ? {
          vin: vehicle.vin,
          description:
            [vehicle.year, vehicle.make, vehicle.model, vehicle.color].filter(Boolean).join(' ') ||
            'Not decoded',
        }
      : null,
    deliveredAt: load?.deliveredAt ?? null,
  };
}

/* -------------------------------------------------------------------------
 * Letters
 * ---------------------------------------------------------------------- */

export interface LetterResult {
  ok: boolean;
  documentId?: string;
  sha256?: string;
  error?: string;
}

interface SendLetterOptions {
  kind: ClaimLetterKind;
  delayReason?: string | null;
  disposition?: Disposition;
  dispositionAmountCents?: number | null;
  declineReason?: string | null;
}

/**
 * Renders, freezes and files one of the Part 370 letters.
 *
 * Nothing here sends email — the carrier does that. What this guarantees is
 * that the exact document that went out exists afterwards, hashed, with the
 * date on its face.
 */
async function sendLetter(
  scoped: ScopedDb,
  claimId: string,
  options: SendLetterOptions,
): Promise<LetterResult> {
  const claim = await scoped.selectOne('claims', eq(claimsTable.id, claimId));
  if (!claim) return { ok: false, error: 'No such claim.' };

  const org = await getOrganization(scoped.orgId);
  if (!org) return { ok: false, error: 'The organisation record is missing.' };

  const [load, vehicle] = await Promise.all([
    claim.loadId ? scoped.selectOne('loads', eq(loadsTable.id, claim.loadId)) : Promise.resolve(null),
    claim.vehicleId
      ? scoped.selectOne('vehicles', eq(vehiclesTable.id, claim.vehicleId))
      : Promise.resolve(null),
  ]);

  const kindColumn =
    options.kind === 'acknowledgement'
      ? 'claim_acknowledgement'
      : options.kind === 'status'
        ? 'claim_status'
        : 'claim_disposition';

  const issuedAt = new Date();

  const bytes = await renderClaimLetter({
    kind: options.kind,
    claimNumber: claim.number,
    issuedAt,
    brand: await brandFor(scoped, kindColumn),
    carrier: {
      name: org.legalName,
      addressLine1: org.addressLine1,
      city: org.city,
      state: org.state,
      postalCode: org.postalCode,
      phone: org.phone,
      email: org.email,
      usdotNumber: org.usdotNumber,
      mcNumber: org.mcNumber,
    },
    claimantName: claim.claimantName,
    claimantEmail: claim.claimantEmail,
    receivedAt: claim.filedAt,
    loadNumber: load?.number ?? null,
    vin: vehicle?.vin ?? null,
    deliveredAt: load?.deliveredAt ?? null,
    demandAmountCents: claim.demandAmountCents,
    delayReason: options.delayReason,
    disposition: options.disposition,
    dispositionAmountCents: options.dispositionAmountCents,
    declineReason: options.declineReason,
    lateFiled: isLateFiled(claim.filedAt, load?.deliveredAt ?? null),
  });

  const stored = await storeDocument({
    scoped,
    kind: kindColumn,
    loadId: claim.loadId,
    subject: `claim:${claimId}`,
    title: claimLetterTitle(options.kind, claim.number),
    bytes,
  });

  if ('error' in stored) return { ok: false, error: stored.error };

  return { ok: true, documentId: stored.documentId, sha256: stored.sha256 };
}

/** 49 CFR 370.5 — the letter that has to go out inside 30 days. */
export async function acknowledgeClaim(scoped: ScopedDb, claimId: string): Promise<LetterResult> {
  const claim = await scoped.selectOne('claims', eq(claimsTable.id, claimId));
  if (!claim) return { ok: false, error: 'No such claim.' };

  if (claim.acknowledgedAt) {
    return { ok: false, error: 'This claim has already been acknowledged.' };
  }
  if (isDisposed(claim.status)) {
    return { ok: false, error: 'This claim is closed.' };
  }

  const letter = await sendLetter(scoped, claimId, { kind: 'acknowledgement' });
  if (!letter.ok) return letter;

  const acknowledgedAt = new Date();

  await scoped.update('claims', eq(claimsTable.id, claimId), {
    status: 'acknowledged',
    acknowledgedAt,
    nextStatusDueAt: nextStatusLetterDue(claim.filedAt, null),
  });

  return letter;
}

/** 49 CFR 370.9 — the letter owed every 60 days once the claim passes 120. */
export async function sendStatusLetter(
  scoped: ScopedDb,
  claimId: string,
  delayReason: string,
): Promise<LetterResult> {
  const claim = await scoped.selectOne('claims', eq(claimsTable.id, claimId));
  if (!claim) return { ok: false, error: 'No such claim.' };

  if (isDisposed(claim.status)) {
    return { ok: false, error: 'This claim is closed, so no status letter is owed.' };
  }

  const letter = await sendLetter(scoped, claimId, { kind: 'status', delayReason });
  if (!letter.ok) return letter;

  const sentAt = new Date();

  await scoped.update('claims', eq(claimsTable.id, claimId), {
    status: claim.status === 'filed' ? claim.status : 'investigating',
    nextStatusDueAt: nextStatusLetterDue(claim.filedAt, sentAt),
  });

  return letter;
}

/* -------------------------------------------------------------------------
 * Disposition
 * ---------------------------------------------------------------------- */

export function isDisposed(status: ClaimStatus): boolean {
  return status === 'paid' || status === 'declined' || status === 'withdrawn';
}

export interface DisposeInput {
  disposition: Disposition;
  amountCents: number | null;
  reason: string | null;
}

/**
 * Pays, declines, or makes a firm compromise settlement offer.
 *
 * All three satisfy 370.9's 120-day requirement; only paying and declining
 * close the file. An offer leaves the claim open, because the claimant has not
 * accepted it yet and the 60-day status obligation continues to run.
 */
export async function disposeClaim(
  scoped: ScopedDb,
  claimId: string,
  input: DisposeInput,
): Promise<LetterResult> {
  const claim = await scoped.selectOne('claims', eq(claimsTable.id, claimId));
  if (!claim) return { ok: false, error: 'No such claim.' };

  if (isDisposed(claim.status)) {
    return { ok: false, error: 'This claim has already been closed.' };
  }

  if (input.disposition !== 'declined' && (input.amountCents ?? 0) <= 0) {
    return {
      ok: false,
      error:
        input.disposition === 'paid'
          ? 'Enter the amount being paid.'
          : 'A compromise offer has to name a figure to be a firm offer.',
    };
  }

  if (input.disposition === 'declined' && !input.reason?.trim()) {
    return {
      ok: false,
      error:
        'A declination has to say why. It is the document the claimant’s two-year window runs ' +
        'from, and a reason nobody wrote down is one nobody can defend.',
    };
  }

  const letter = await sendLetter(scoped, claimId, {
    kind: 'disposition',
    disposition: input.disposition,
    dispositionAmountCents: input.amountCents,
    declineReason: input.reason,
  });

  if (!letter.ok) return letter;

  const now = new Date();

  if (input.disposition === 'offered') {
    await scoped.update('claims', eq(claimsTable.id, claimId), {
      status: 'offered',
      offerAmountCents: input.amountCents,
      offeredAt: now,
      // Still pending, so the 60-day obligation keeps running.
      nextStatusDueAt: nextStatusLetterDue(claim.filedAt, now),
    });
  } else if (input.disposition === 'paid') {
    await scoped.update('claims', eq(claimsTable.id, claimId), {
      status: 'paid',
      settledAmountCents: input.amountCents,
      settledAt: now,
      nextStatusDueAt: null,
    });
  } else {
    await scoped.update('claims', eq(claimsTable.id, claimId), {
      status: 'declined',
      declinedAt: now,
      declineReason: input.reason?.trim() ?? null,
      nextStatusDueAt: null,
    });
  }

  return letter;
}

/** The claimant walked away. Closes the file without a decision on the merits. */
export async function withdrawClaim(
  scoped: ScopedDb,
  claimId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const claim = await scoped.selectOne('claims', eq(claimsTable.id, claimId));
  if (!claim) return { ok: false, error: 'No such claim.' };

  if (isDisposed(claim.status)) return { ok: false, error: 'This claim is already closed.' };
  if (!reason.trim()) return { ok: false, error: 'Record why the claim was withdrawn.' };

  await scoped.update('claims', eq(claimsTable.id, claimId), {
    status: 'withdrawn',
    declineReason: reason.trim(),
    nextStatusDueAt: null,
  });

  return { ok: true };
}

/**
 * Releases the legal hold a claim put on a load.
 *
 * Deliberately not automatic on disposition. A declined claim can still become
 * a lawsuit for two years, and the records are the defence — so somebody has
 * to decide the exposure has passed.
 */
export async function releaseHold(
  scoped: ScopedDb,
  claimId: string,
  actor?: { userId: string | null; role: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const claim = await scoped.selectOne('claims', eq(claimsTable.id, claimId));
  if (!claim) return { ok: false, error: 'No such claim.' };
  if (!claim.loadId) return { ok: false, error: 'This claim is not attached to a load.' };

  if (!isDisposed(claim.status)) {
    return { ok: false, error: 'This claim is still open, so the records stay on hold.' };
  }

  const otherOpen = (await scoped.select('claims', eq(claimsTable.loadId, claim.loadId))).filter(
    (other) => other.id !== claimId && !isDisposed(other.status),
  );

  if (otherOpen.length > 0) {
    return {
      ok: false,
      error: `Claim ${otherOpen[0]?.number} on this load is still open, so the hold stays.`,
    };
  }

  /*
   * Releases every hold on the load, not just this claim's. A second claim on
   * the same load places its own, and `releaseHolds` leaves the flag set while
   * any of them is still live — so closing one claim cannot expose a load that
   * another is still protecting.
   */
  await releaseHolds(scoped, holdOnLoad(claim.loadId), {
    userId: actor?.userId ?? null,
    role: actor?.role ?? null,
  });
  return { ok: true };
}

/** Customer on a claim, for display. */
export async function claimCustomerName(
  scoped: ScopedDb,
  customerId: string | null,
): Promise<string | null> {
  if (!customerId) return null;
  const customer = await scoped.selectOne('customers', eq(customersTable.id, customerId));
  return customer?.name ?? null;
}
