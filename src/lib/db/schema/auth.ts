import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, encrypted, id, json, pk, timestamps, ts } from '../columns';

/** Roles inside a carrier organisation. */
export const ORG_ROLES = ['owner', 'dispatcher', 'driver', 'accounting'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ORG_KINDS = ['carrier', 'broker', 'shipper'] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

/**
 * A tenant. Every operational row in the database belongs to exactly one.
 */
export const organizations = sqliteTable(
  'organizations',
  {
    id: pk(),
    kind: text('kind', { enum: ORG_KINDS }).notNull().default('carrier'),
    legalName: text('legal_name').notNull(),
    dbaName: text('dba_name'),

    // FMCSA identifiers. Verified against QCMobile, cached in `carrierChecks`.
    usdotNumber: text('usdot_number'),
    mcNumber: text('mc_number'),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country').notNull().default('US'),
    phone: text('phone'),
    email: text('email'),

    /** Retention floor in days. Defaults to 7 years — see docs/COMPLIANCE.md. */
    retentionDays: integer('retention_days').notNull().default(2557),

    ...timestamps,
  },
  (t) => [
    index('organizations_usdot_idx').on(t.usdotNumber),
    index('organizations_mc_idx').on(t.mcNumber),
  ],
);

export const users = sqliteTable(
  'users',
  {
    id: pk(),
    email: text('email').notNull(),
    /** Argon2id envelope. Null for accounts that authenticate another way. */
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull(),
    phone: text('phone'),

    emailVerifiedAt: ts('email_verified_at'),
    /** Set when an owner deactivates the account; blocks every new session. */
    disabledAt: ts('disabled_at'),

    /** Consecutive failed sign-ins, reset on success. Feeds lockout. */
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastLoginAt: ts('last_login_at'),

    ...timestamps,
  },
  // Email is lower-cased before write so this index is genuinely unique.
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

/**
 * Membership joins a user to an organisation with a role.
 *
 * A user may belong to several organisations — an owner-operator who also
 * dispatches for a partner fleet is common — so role lives here, not on the
 * user.
 */
export const memberships = sqliteTable(
  'memberships',
  {
    id: pk(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ORG_ROLES }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('memberships_org_user_uq').on(t.orgId, t.userId),
    // "Which orgs does this user belong to?" needs its own index: only the
    // leading column of a composite index is usable on its own.
    index('memberships_user_idx').on(t.userId),
  ],
);

/**
 * Opaque server-side sessions.
 *
 * The cookie holds a 256-bit random token; only its SHA-256 is stored, so a
 * database leak yields no usable sessions. Opaque rather than JWT because a
 * fired dispatcher must lose access immediately, and "their token expires in
 * fifteen minutes" is not an acceptable answer for a load board.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),

    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ORG_ROLES }).notNull(),

    createdAt: ts('created_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    /** Extended on activity. */
    idleExpiresAt: ts('idle_expires_at').notNull(),
    /** Never extended. A hard ceiling on session lifetime. */
    absoluteExpiresAt: ts('absolute_expires_at').notNull(),

    /** Proves MFA was satisfied recently, for step-up on sensitive actions. */
    mfaVerifiedAt: ts('mfa_verified_at'),

    ipCreated: text('ip_created'),
    userAgentCreated: text('user_agent_created'),
    deviceLabel: text('device_label'),

    revokedAt: ts('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_idle_expires_idx').on(t.idleExpiresAt),
  ],
);

/** TOTP enrolment. The secret is encrypted at rest like any other secret. */
export const totpCredentials = sqliteTable(
  'totp_credentials',
  {
    id: pk(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** AES-256-GCM envelope of the base32 secret. */
    secretEncrypted: encrypted('secret_encrypted').notNull(),
    /** Null until the user proves they can generate a valid code. */
    activatedAt: ts('activated_at'),
    /**
     * Last accepted time step. Rejecting a repeat closes the replay window
     * that would otherwise let a shoulder-surfed code work for 90 seconds.
     */
    lastUsedStep: integer('last_used_step'),
    ...timestamps,
  },
  (t) => [uniqueIndex('totp_user_uq').on(t.userId)],
);

/**
 * Single-use MFA recovery codes.
 *
 * Hashed with SHA-256 rather than Argon2 deliberately: these carry ~50 bits of
 * uniform entropy, so brute force is already infeasible and a slow hash would
 * only add login latency and a denial-of-service surface.
 */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: pk(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

/** Pending invitations to join an organisation. */
export const invitations = sqliteTable(
  'invitations',
  {
    id: pk(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ORG_ROLES }).notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: text('invited_by_user_id').references(() => users.id),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    revokedAt: ts('revoked_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('invitations_token_uq').on(t.tokenHash),
    index('invitations_org_idx').on(t.orgId),
  ],
);

/**
 * Rate limit counters.
 *
 * Kept in the database rather than memory so limits survive a restart and
 * hold across multiple app instances without another service.
 */
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    /** e.g. "login:ip:203.0.113.4" or "totp:user:0192f..." */
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    windowStartedAt: ts('window_started_at').notNull(),
    blockedUntil: ts('blocked_until'),
  },
  (t) => [index('rate_limits_window_idx').on(t.windowStartedAt)],
);

/**
 * ESIGN consent, captured before the first electronic disclosure to an
 * individual (non-business) shipper.
 *
 * 15 U.S.C. 7001(c) requires a specific set of disclosures, and 49 CFR
 * 390.32(d) imports that requirement for motor carrier documents. The exact
 * text shown is stored by hash and version so it can be reproduced years
 * later — a consent you cannot reproduce is a consent you cannot rely on.
 */
export const esignConsents = sqliteTable(
  'esign_consents',
  {
    id: pk(),
    orgId: text('org_id').notNull(),
    /** Null for a walk-up party with no account. */
    userId: text('user_id').references(() => users.id),
    partyEmail: text('party_email'),
    partyName: text('party_name').notNull(),

    disclosureVersion: text('disclosure_version').notNull(),
    disclosureSha256: text('disclosure_sha256').notNull(),
    /** 'transaction' or 'ongoing' — 15 U.S.C. 7001(c)(1)(B)(i). */
    scope: text('scope', { enum: ['transaction', 'ongoing'] }).notNull(),

    consentedAt: ts('consented_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    withdrawnAt: ts('withdrawn_at'),

    createdAt: ts('created_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('esign_consents_org_idx').on(t.orgId)],
);

/**
 * Driver privacy consent for location capture.
 *
 * Several states require prior written notice of electronic monitoring, and
 * capturing consent with the exact text shown is cheap insurance regardless
 * of jurisdiction.
 */
export const monitoringConsents = sqliteTable(
  'monitoring_consents',
  {
    id: pk(),
    orgId: text('org_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    noticeVersion: text('notice_version').notNull(),
    noticeSha256: text('notice_sha256').notNull(),
    consentedAt: ts('consented_at').notNull(),
    withdrawnAt: ts('withdrawn_at'),
    ipAddress: text('ip_address'),
    createdAt: ts('created_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('monitoring_consents_user_idx').on(t.userId)],
);

/**
 * Per-subject encryption keys, wrapped by the root key.
 *
 * Destroying a row here renders every ciphertext for that data subject
 * permanently unreadable without touching the bill of lading, its content
 * hash, or the audit chain — which is how an erasure request is satisfied
 * while a 7-year retention obligation still stands.
 */
export const subjectKeys = sqliteTable('subject_keys', {
  subjectId: text('subject_id').primaryKey(),
  orgId: text('org_id').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  createdAt: ts('created_at')
    .notNull()
    .$defaultFn(() => new Date()),
  /** Tombstone: proves when the key was destroyed, not what it protected. */
  destroyedAt: ts('destroyed_at'),
  destroyedReason: text('destroyed_reason'),
});

/** Encrypted personal data, addressed by subject rather than inlined on rows. */
export const piiVault = sqliteTable(
  'pii_vault',
  {
    subjectId: pk('subject_id'),
    orgId: text('org_id').notNull(),

    nameEncrypted: encrypted('name_encrypted'),
    emailEncrypted: encrypted('email_encrypted'),
    phoneEncrypted: encrypted('phone_encrypted'),
    addressEncrypted: encrypted('address_encrypted'),
    dobEncrypted: encrypted('dob_encrypted'),
    cdlNumberEncrypted: encrypted('cdl_number_encrypted'),

    /**
     * Truncated HMAC of the CDL number, for exact-match lookup without
     * decrypting every row. Org-scoped so two carriers employing the same
     * driver produce different values.
     *
     * Deliberately absent for date of birth and any financial identifier:
     * those domains are small enough that an index is close to plaintext.
     */
    cdlBlindIndex: text('cdl_blind_index'),

    /** Plaintext, because the UI needs it and banks print it. */
    accountLast4: text('account_last4'),

    redactedAt: ts('redacted_at'),
    redactionReason: text('redaction_reason'),

    ...timestamps,
  },
  (t) => [index('pii_vault_cdl_bidx').on(t.orgId, t.cdlBlindIndex)],
);

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Session = typeof sessions.$inferSelect;

/** Shape of the JSON payload stored on an invitation, kept for reference. */
export type InvitationMeta = ReturnType<typeof json<{ note?: string }>>;
