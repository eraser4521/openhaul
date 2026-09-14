# Security

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability reporting
(Security → Report a vulnerability) so a fix can ship before the details are public.

Include what you did, what happened, and what you expected. A proof of concept helps enormously.
You will get an acknowledgement within 72 hours and an assessment within a week.

OpenHaul is self-hosted, so a disclosed vulnerability is a vulnerability in *running instances* that
operators must patch themselves. That makes coordinated disclosure more important here than it is
for a hosted product where one deploy fixes everyone.

## What this application protects

Instances hold driver personal data, customer contact details, vehicle identification numbers,
timestamped location data, photographs, and electronic signatures on documents that carry legal
weight for years. The realistic threats are a stolen database file, a compromised account, a
tenant-isolation bug, and tampering with evidence after the fact.

---

## Tenant isolation

SQLite has no row-level security, no database roles, and no `SET LOCAL`. Isolation therefore cannot
be pushed into the engine, and discipline alone eventually fails. Three mechanisms back each other:

**1. A scoped client that cannot be built without a tenant.**
`forOrg(orgId)` in `src/lib/db/scope.ts` is the only sanctioned way to reach tenant data. It welds
`org_id = ?` onto every read, forces `org_id` on every insert, and strips it from every update so a
load can never be moved between organisations. Feature code never receives a raw database handle,
and an ESLint rule blocks the import.

**2. Composite foreign keys.**
Every tenant table carries `UNIQUE (org_id, id)`, and children reference `(org_id, parent_id)`. A
bill of lading in organisation A physically cannot point at a load in organisation B — the foreign
key rejects it. This holds when application code is wrong, during a migration, and during a bulk
import.

**3. A test that catches the table nobody remembered.**
`tests/tenant-isolation.test.ts` enumerates every exported table with an `org_id` column and fails
if one appears in neither the scoped registry nor `TENANT_SCOPE_EXEMPT`. Exemptions require a
written reason; there are four, all cases where a tenant context does not yet exist (session lookup
by token, membership, invitation redemption, and the global audit chain).

A runtime tripwire also aborts the request and writes an audit entry if a row from another
organisation ever surfaces, turning a silent leak into a loud failure.

**Business uniqueness is always per tenant.** `UNIQUE (org_id, number)`, never `UNIQUE (number)` —
a global constraint leaks the existence of another carrier's load through a duplicate-key error.

---

## Encryption

### Field level

Personal data is sealed with **AES-256-GCM**, keyed by **HKDF-SHA-256** subkeys derived per purpose,
so the key protecting licence numbers is cryptographically unrelated to the one protecting dates of
birth.

This is done in the application rather than the database deliberately. A database-side function
needs the key passed in the query text, and both SQLite and Postgres log query parameters under
common debugging configurations — which would write the key and the plaintext into the same log
file.

**Additional authenticated data binds each ciphertext to its exact location:**

```
AAD = length-prefixed(key version ‖ org_id ‖ table ‖ column ‖ row_id)
```

Without this, anyone able to write one column could copy an encrypted licence number from one
driver's row into another's and it would decrypt cleanly. Components are length-prefixed so
`("ab","c")` and `("a","bc")` cannot produce the same authenticated bytes.

The envelope is self-describing — `v<N>:<iv>:<tag>:<ciphertext>` — so rotation never orphans data.

### Key rotation

Prepend a new version to `OPENHAUL_KEYS`. Old ciphertexts stay readable because each names the
version that sealed it; new writes use the newest key; a backfill re-seals at leisure.

The **blind-index key is pinned separately** (`OPENHAUL_INDEX_KEY_VERSION`) and does not move when
a field key rotates. Rotating it invalidates every stored index value and requires re-indexing those
columns in the same migration. This is the detail that bites people a year in.

### Blind indexes

Exact-match lookup on an encrypted column uses a truncated HMAC, with a distinct key per index and
the organisation id folded into the input. Two carriers employing the same driver therefore produce
different index values, which removes cross-tenant frequency analysis and stops one carrier probing
whether a driver also works elsewhere.

**Dates of birth, social security numbers and bank details are deliberately not indexed.** Those
domains are small enough that an index over them is close to plaintext, and nothing in the
application searches by them. `account_last4` is stored in plaintext on purpose, so rendering a
row never requires decrypting a full account number.

### At rest

`DATABASE_ENCRYPTION_KEY` encrypts the whole database file, protecting a stolen disk or a copied
backup. Field-level encryption additionally protects against an application-level read, a leaked
backup, and an over-broad admin query. Both are worth having; neither replaces the other.

---

## Authentication

**Passwords** — Argon2id at **m=19456, t=2, p=1**, the OWASP Password Storage configuration that
fits a small VPS. The 46 MiB alternative is equally approved but multiplies by concurrent sign-ins
and will exhaust the deployment target. An optional `PASSWORD_PEPPER` lives outside the database, so
a pure database dump is useless.

Hashes are upgraded on login when they predate current policy.

**Sessions** are opaque 256-bit random tokens; only a SHA-256 is stored. JWTs were rejected because
they cannot be revoked — when a dispatcher is let go, "their token expires in fifteen minutes" is
not an acceptable answer for a load board.

Timeouts are role-aware:

| Role | Idle | Absolute |
|---|---|---|
| Driver | 30 days | 90 days |
| Dispatcher, owner | 8 hours | 12 hours |
| Accounting | 1 hour | 8 hours |

The driver window is long on purpose. A driver in a canyon with no signal cannot re-authenticate,
and forcing it means either lost inspection data or passwords written on the dash. The compensating
controls are immediate server-side revocation, a device list the owner can inspect, and step-up MFA
on anything sensitive — not a blanket short expiry.

Cookies use the `__Host-` prefix in production, which the browser rejects unless it is `Secure`,
`Path=/`, and carries no `Domain` — making subdomain cookie fixation structurally impossible.

Sessions rotate on every privilege change: sign-in, MFA completion, password change, role change.

**TOTP** uses SHA-1/6/30. That is an interoperability choice, not a security one: most
authenticator apps ignore the algorithm field in an `otpauth://` URI, so deviating produces codes
that silently never match. Security comes from the 160-bit secret. The accepted time step is
recorded and a repeat rejected, closing the window where a shoulder-surfed code stays usable.

**Recovery codes** are hashed with SHA-256, not Argon2 — deliberately. They carry ~50 bits of
uniform entropy, so brute force is already infeasible; a slow hash would only add login latency and
a denial-of-service surface.

**Rate limits** apply per account *and* per address. A carrier's whole yard can sit behind one NAT
address, so address-only limiting locks out everyone when one driver mistypes a password.

---

## Authorisation

Server Actions are public POST endpoints. A check on the page that renders a form does **not**
protect the action defined beside it, and a layout cannot stop a route segment from rendering. So
every action and route handler calls `requireCapability` next to the data.

The capability matrix lives in a module with no server-only imports, so navigation can hide what a
role cannot use. **Hiding is presentation, not enforcement** — a hidden button is not a permission
check, and the server re-verifies regardless.

No separate ownership check follows an authorisation check. The scoped client cannot reach another
organisation's rows, so "does this load belong to me" is answered by the query itself rather than by
a second lookup somebody might forget.

---

## Audit log

Append-only, hash-chained. Each entry commits to the hash of the previous one, so removing or
editing a row breaks the chain at a point verification can name — gap, broken link, or altered
contents. Append-only SQLite triggers sit on top, and the same applies to signature events and
finalised documents.

**Be clear about what that does and does not prove.** Triggers stop the application and a careless
operator. They do not stop someone with write access to the database file, who can drop them. The
chain is what *detects* that — and only if the head hash is anchored somewhere the same person does
not control. Export it; the application says so rather than implying the triggers are the protection.

The log records authentication events, load and document lifecycle changes, every signature, every
decryption of personal data, exports, permission denials, and tenant-isolation violations.

**No decrypted personal data is ever written to it.** The audit log is the one table that cannot be
purged, so personal data in it would defeat the erasure story entirely.

---

## Erasure versus retention

These obligations genuinely conflict: privacy law grants deletion rights, and carriers must retain
transport records for years. The resolution is to separate the record from the identity.

Personal data lives in a per-subject vault sealed with a per-subject key. An erasure request
**destroys that key**. The bill of lading, its content hash, and the audit chain are untouched; the
personal data becomes unreadable — including in backups and replicas, which a `SET column = NULL`
would never reach.

This is positioned as *rendering data inaccessible in fulfilment of an erasure request*, not as
anonymisation. European regulators have generally not treated encrypted data as anonymous, and
overclaiming here would be worse than useless.

When retention or a legal hold blocks erasure, the honest answer is given: what was removed, what
is retained, under which citation, and until when.

---

## Transport and headers

A per-request nonce drives the Content Security Policy from `src/proxy.ts`.

`'wasm-unsafe-eval'` is present because the barcode decoder is WebAssembly; it permits WASM
compilation only, not `eval()` of JavaScript. `'strict-dynamic'` means only nonce-tagged scripts
and what they load will run.

The cost is real and worth stating: nonces force dynamic rendering, so static optimisation is off.
For a per-user load board that is no loss.

`Permissions-Policy` grants `camera=(self)` for VIN scanning and `geolocation=(self)` for stamping
inspections, and denies everything else.

HSTS defaults to one year **without** `includeSubDomains` or `preload`. Forcing those on a
self-hoster running OpenHaul on one subdomain alongside other services would be hostile; set
`HSTS_HEADER` if you control the whole domain.

---

## Uploads

Images are allowlisted to JPEG, PNG and WebP by **magic bytes**, never the `Content-Type` header,
which is attacker-controlled. SVG is rejected outright — it is an XSS vector and there is no use
for it here.

Every image is re-encoded, which destroys embedded payloads. EXIF is extracted into database columns
**before** re-encoding, because the timestamp and GPS in an inspection photo are exactly the
evidence a cargo claim turns on. Serving a stripped derivative while keeping the original immutable
resolves the tension between privacy hygiene and evidentiary value.

Storage keys are content-addressed by SHA-256, never user-supplied filenames.

---

## Outbound requests

The NHTSA and FMCSA lookups are proxied server-side. Callers name an **upstream key and a path**,
never a URL, so the endpoint cannot be turned into a general-purpose fetcher. Redirects are refused,
requests are time-limited, and responses are size-capped — a `302` to a cloud metadata endpoint is
the classic SSRF pivot.

Results are cached aggressively. Both services have had extended outages, and neither should be able
to block a driver from recording a vehicle.

---

## Secrets

`scripts/generate-secrets.mjs` writes strong values on first run, so no instance ever ships with a
default. The application refuses to start in production if a secret is missing or looks like a
placeholder.

Never prefix a secret with `NEXT_PUBLIC_`; that ships it to the browser.

If you run more than one instance, set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`. Next.js encrypts values
closed over by Server Actions with a per-build key, and separate instances otherwise generate
different keys and fail intermittently and inexplicably.

---

## Known limitations

Stated plainly, because a security document that only lists strengths is not useful:

- **Append-only is application-level.** Anyone with write access to the database file can drop the
  triggers. Only an exported chain head detects it.
- **Blind indexes leak equality.** An attacker with the database learns which rows share a licence
  number, though not which one. That is the accepted trade for searchability, and is why the
  low-entropy fields are not indexed at all.
- **No hardware key support yet.** Passkeys would be phishing-resistant and better UX than typing a
  TOTP in a cold yard. The credential schema is shaped to hold them.
- **Photo storage encryption is deployment-dependent.** The filesystem driver relies on volume
  encryption; app-level streaming encryption is not implemented yet.
- **Rate limiting is fixed-window.** Simple and adequate here, but a sliding window would be
  strictly better under burst traffic.
