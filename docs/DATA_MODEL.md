# Data model

30 tables in five groups. Schema lives in `src/lib/db/schema/`, generated migrations in `drizzle/`.

---

## Conventions

**Primary keys are UUIDv7 stored as TEXT.** Version 7 rather than 4 because the leading 48 bits are
a millisecond timestamp, so keys sort chronologically — B-tree inserts land at the right edge
instead of fragmenting the index, and photos get a capture order for free. TEXT rather than
BLOB(16) costs 2.2× the bytes and buys something worth more: rows you can read in a log and grep in
a shell.

**Money is integer cents, always.** SQLite REAL is IEEE-754 binary floating point, where
`0.1 + 0.2 !== 0.3`. A rounding error on a bill of lading is an accounting and legal problem, not a
cosmetic one. Every monetary column is suffixed `Cents` so the unit is unambiguous at the call site,
and a test fails on any integer column that looks monetary without saying so.

Percentages are basis points, suffixed `Bps`. `2800` is 28%.

**Timestamps are epoch milliseconds, UTC.** Not ISO strings: three times the bytes, no efficient
index range scan, and timezone ambiguity nobody needs.

**Booleans are INTEGER 0/1**, because SQLite has no boolean type.

**`org_id` on every tenant row**, with `UNIQUE (org_id, id)` so children can reference
`(org_id, parent_id)` — see [ARCHITECTURE.md](ARCHITECTURE.md).

**Business uniqueness is scoped to the tenant.** `UNIQUE (org_id, number)`, never `UNIQUE (number)`.
A global constraint leaks the existence of another carrier's load through a duplicate-key error.

---

## Identity and access

| Table | Purpose |
|---|---|
| `organizations` | The tenant. Carrier, broker or shipper, with authority numbers and retention policy |
| `users` | A person. Email is lower-cased before write so the unique index is genuinely unique |
| `memberships` | Joins a user to an organisation **with a role**. Role lives here, not on the user, because an owner-operator who also dispatches for a partner fleet is common |
| `sessions` | Keyed by SHA-256 of the token. The raw token exists only in the cookie |
| `totp_credentials` | Secret encrypted at rest; `lastUsedStep` closes the replay window |
| `recovery_codes` | One row per code, single use, marked consumed inside the authenticating transaction |
| `invitations` | Token-hashed, expiring |
| `rate_limits` | Fixed-window counters. In the database so limits survive a restart without adding Redis |

Roles are `owner`, `dispatcher`, `driver`, `accounting`. The capability matrix is in
`src/lib/auth/capabilities.ts`.

---

## Privacy

| Table | Purpose |
|---|---|
| `pii_vault` | Encrypted personal data, addressed by subject rather than inlined on business rows |
| `subject_keys` | Per-subject key, wrapped by the root. **Destroying a row here is how erasure works** |
| `esign_consents` | ESIGN consent with the disclosure stored by version and hash, so the exact text shown is reproducible years later |
| `monitoring_consents` | Driver location-monitoring notice, same versioned pattern |

The separation exists so an erasure request can destroy one person's key while the bill of lading,
its content hash and the audit chain stay intact and valid.

`pii_vault.cdlBlindIndex` is a truncated, org-scoped HMAC for exact-match lookup. There is
deliberately no equivalent for date of birth or financial identifiers — those domains are small
enough that an index over them is close to plaintext, and nothing searches by them.

---

## Operations

```
organizations
 └── loads ─┬── stops        (pickup, delivery)
            ├── vehicles     (one row per VIN)
            └── inspections ─┬── inspection_photos
                             └── damages
```

**`loads`** carries the status machine (`draft → posted → offered → accepted → dispatched →
picked_up → in_transit → delivered → invoiced → paid`, with `cancelled` and `declined` as terminal
branches), the money fields, and `legalHold` / `retainUntil`.

Both `rateCents` (carrier pay) and `tariffCents` (customer billing) are stored; the spread is the
broker fee. `fuelSurchargeCents` is separate on purpose — it is always its own invoice line and
never folded into the line haul.

**`vehicles`** is the unit of liability. `vinCheckDigitValid` records whether the VIN passed its own
check digit at entry, which is different from refusing to store it. `isInoperable` matters
operationally: it changes loading position, equipment and price, and an undisclosed inoperable is
the most common cause of a refused load.

**`venues`** separates the place from the stop, because the same auction gets visited repeatedly.
`requiresTwic` and `gateCode` are there because a driver who arrives without either wastes a day.

**`equipment`** stores capacity as **both** slots and pounds. Capacity is really weight-bound: a
deck that holds ten sedans holds seven pickups.

**`vin_decodes`** caches NHTSA responses with no TTL. A VIN's manufacturing specification never
changes. Shared across organisations because the data is public.

---

## Inspections

**`inspections`** — one per vehicle per leg. Holds the GPS fix, the odometer, and `limitationNote`,
which records when conditions prevented a full inspection. That field matters: the AIAG standard is
explicit that damage missed because a vehicle was dirty or snow-covered is **not** concealed damage,
so writing the limitation down at pickup is what preserves the carrier's position later.

`contentHash` is computed over the canonical serialisation including every photo hash. `version`
gives the offline sync path optimistic concurrency. `amendsInspectionId` is how a finalised report
gets corrected — by supersession, never by edit.

**`inspection_photos`** — content-addressed by SHA-256. EXIF capture time and GPS are extracted into
columns at ingest, then the served derivative is re-encoded and stripped. This resolves a real
conflict: stripping EXIF is correct for privacy and safety, but the timestamp and GPS are exactly
what makes the photo evidence. Keep the original immutable, serve something else.

`withinGeofence` records whether capture happened near the stop — the anti-fraud signal carrier
scorecards actually grade.

**`damages`** — AIAG M-22 coded. `areaCode` (2) + `typeCode` (2) + `severityCode` (1) + optional
`gridCode`, with `codeVersion` recorded because the standard revises its tables and a 2026 report
must still render correctly in 2033.

`preExisting` is the field that protects the carrier: damage marked at pickup was already there.
`nonTransportation` flags conditions the standard says are not transport damage at all — paint runs,
severity-1 dents with no paint damage, missing emblems with no installation holes.

**`signature_events`** — append-only, hash-chained, and deliberately verbose. Authentication method,
the SHA-256 of the exact bytes displayed, stroke timing, GPS, IP, and both server and device clocks.
Courts have rejected signatures backed only by a name and a timestamp because nobody could explain
the procedure linking the signature to the person; every field here exists to answer that.

`customerUnavailable` handles the real case where nobody is there to sign.

---

## Billing

| Table | Notes |
|---|---|
| `invoices` | Components stored discretely, not as one total — a broker will hold an invoice over a cent that does not match the rate confirmation |
| `payments` | Partial payments against an invoice |
| `expenses` | Fuel, tolls, car-pulling, with a receipt photo |
| `settlements` | Driver pay: revenue minus broker fees, times the pay rate |
| `accessorial_rates` | The carrier's own named charges, with a rate and the unit it is counted in |
| `invoice_accessorials` | One itemised charge on one invoice, holding its own copy of the label and rate |

`invoices.factoringNoticeText` exists because a factoring company requires a Notice of Assignment
on the invoice face. Without it the broker pays the carrier and the factor comes after the carrier
for the money.

`invoice_accessorials` copies rather than references. A line takes its label, unit and rate out of
`accessorial_rates` at the moment it is added, so editing the catalogue never reaches an invoice
that already cites it — the customer is holding a document stating a figure, and a rate rise in
June cannot change what was charged in March. `invoices.accessorialCents` is the sum of the lines,
re-derived on every write rather than adjusted.

---

## Compliance

| Table | Notes |
|---|---|
| `documents` | Frozen PDF bytes with a SHA-256. Superseded, never edited |
| `document_templates` | The carrier-owned layer of a document: letterhead, colour, footer, extra terms |
| `audit_log` | Hash-chained, append-only. `prevHash` links each entry to the last |
| `audit_anchors` | Periodic chain head export — a chain inside the database it protects proves little |
| `claims` | Cargo claims with the 30/120/180/240-day deadlines as real dates |
| `insurance_certificates` | Expiry tracking. Cargo cover for general freight is **not** filed with FMCSA, so an uploaded certificate is the only verification available |
| `carrier_checks` | Cached FMCSA authority lookups. The service has had extended outages, so nothing hard-fails on it |
| `retention_policies` | Per record class, with an anchor type and a citation |
| `legal_holds` | Suspends every retention and purge job for a subject |

### Why retention has its own table

Retention is **not one clock**. A single driver's data spans at least eight regimes:

| Record | Period | Anchored to |
|---|---|---|
| Bills of lading | 1 year (floor) | Date of the document |
| Driver qualification file | Employment + 3 years | Termination |
| Medical certificate | 3 years | Date of execution |
| Drug and alcohol positives | 5 years | Date of test |
| Records of duty status | 6 months | **Date of receipt** |
| Vehicle inspection reports | 3 months | Date prepared |
| Accident register | 3 years | Date of accident |
| Maintenance records | 1 year + 6 months | **After the vehicle leaves the carrier's control** |

Those anchors are different events. Any implementation keyed off a single `created_at` is wrong
somewhere, so each policy records its own `anchorType`, `retentionDays`, `floorDays` and `citation`.

The floor for a bill of lading is one year; the default is seven, because Carmack allows a claim up
to nine months after delivery and suit two years after a denial. Tenants can raise it. They cannot
go below the regulatory minimum.

---

## Changing the schema

```bash
# 1. Edit src/lib/db/schema/*.ts
# 2. Generate the migration
npm run db:generate
# 3. Review the SQL in drizzle/ -- it is a release artefact, not a scratch file
# 4. Apply it
npm run db:migrate
# 5. Confirm the registry test still passes
npm test
```

A new table with an `org_id` must be added to `TENANT_TABLES` in `src/lib/db/scope.ts`, or to
`TENANT_SCOPE_EXEMPT` with a written reason. The test fails otherwise, which is the point.

**Anything destructive uses expand/contract.** Release N adds the new column and dual-writes;
N+1 backfills; N+2 drops the old one. Never stop writing a column and drop it in the same release —
that is what makes a rollback survivable for someone upgrading unattended.
