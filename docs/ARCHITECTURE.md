# Architecture

This document records the decisions that are expensive to reverse, and why they went the way they
did. Where a choice has a real cost, the cost is stated.

---

## The shape of the problem

Auto transport is not general freight, and the differences drive most of the design.

A load is **several vehicles**, each individually identified, each with its own condition history.
The unit of liability is the vehicle, not the shipment. Capacity is **weight-bound**, not
slot-bound: an open carrier that holds ten sedans holds seven pickups.

Most importantly, the paperwork is **evidence**. Under the Carmack Amendment a shipper makes its
case by showing the vehicle went onto the truck in good condition, and the carrier has nine months
of claim exposure plus two years of suit exposure after a denial. A condition report is not a
record of work done; it is the artefact a dispute turns on years later.

That single fact explains the immutability rules, the frozen PDFs, the hash chain, and the
per-record-class retention model. Everything else is ordinary application code.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16, App Router | Server Components keep database access on the server by construction |
| Language | TypeScript, strict + `noUncheckedIndexedAccess` | Array access returns `T \| undefined`, which is true and catches real bugs |
| Styling | Tailwind v4, OKLCH tokens | Perceptually even lightness steps; the brand amber keeps its chroma on dark surfaces |
| Animation | Motion | Scroll-driven reveals that respect `prefers-reduced-motion` |
| Database | SQLite via libSQL | One file to back up |
| ORM | Drizzle, pinned exact | Schema is TypeScript; migrations are committed SQL |
| Barcode | `barcode-detector` over ZXing WASM | One standard API, native where available |

### SQLite, honestly

**For.** The target user runs one to ten trucks. "Copy one file" beats "learn to operate Postgres."
Photos live in object storage, which removes the biggest write-volume driver. FTS5 covers load and
VIN search. Litestream gives continuous replication with point-in-time restore.

**Against, and the mitigations.**

*Single writer.* Five drivers flushing offline queues at 5pm serialise. Mitigated with WAL,
`busy_timeout=5000`, short transactions, and batched photo registration — one transaction for forty
rows, not forty transactions.

*No row-level security.* This is the big one, and it is why tenant isolation is built the way it is.
It is not defence in depth for its own sake; it is the compensating control for a missing database
feature.

*No PostGIS.* If geofencing or radius lane search becomes a requirement, that is the forcing
function to move. The schema imports dialect types through one boundary so the move is a config
change rather than a rewrite.

`@libsql/client` points at a local file. Turso's Rust rewrite is pre-1.0 and not appropriate for a
fleet's legal documents yet.

### Drizzle, pinned

`drizzle-orm` is pinned to an exact version rather than a caret range. Version 1.0 is iterating
through release candidates and reassigns `db.query`, which is a breaking change this project will
take deliberately rather than absorb from a lockfile refresh.

---

## Tenant isolation

Three mechanisms, chosen so that each covers the others' failure mode.

**The scoped client** (`src/lib/db/scope.ts`) is the only sanctioned route to tenant data. It welds
`org_id = ?` onto reads, forces it on inserts, and strips it from updates so a load cannot be moved
between organisations. Feature code never holds a raw handle, and an ESLint rule blocks the import.

**Composite foreign keys** make a cross-tenant reference physically impossible. Every tenant table
carries `UNIQUE (org_id, id)`; children reference `(org_id, parent_id)`. This survives application
bugs, migrations, and bulk imports — it is the closest thing to row-level security SQLite offers,
and it is genuinely strong.

**A registry test** fails when a new table has an `org_id` but appears in neither the scoped
registry nor a documented exemption. The exemptions are four, all places where a tenant context does
not yet exist: session lookup by token, membership (which establishes the context), invitation
redemption, and the global audit chain.

A runtime tripwire aborts the request and writes an audit entry if a foreign row ever surfaces,
turning a silent leak into a loud failure.

### Brokers and shippers

External parties who should see **one load**, not an organisation, do not get a membership. They get
a grant against a specific load with its own expiry. Conflating the two axes — organisation
membership and per-resource grants — is where cross-tenant leaks come from.

---

## Immutability

```
draft ──► in_progress ──► signed ──► finalized (frozen)
```

Once signed, an inspection is never edited. A correction is an **amendment** that references what it
supersedes. An offline device that edits a finalised record receives a 409 with the server state and
an amendment template — never a silent merge, and never an overwrite.

This is not merely a technical preference. A signed bill of lading is a legal document; silently
mutating one destroys its evidentiary value and arguably its admissibility.

The same applies to documents. The **rendered PDF bytes are frozen and hashed at finalisation**.
Regenerating a 2026 bill from a 2033 template does not reproduce the record that was agreed, and
the electronic-records standard requires that records remain capable of accurate reproduction.

SQLite triggers enforce append-only on the audit log, signature events, and finalised documents.

### The correction problem

A common complaint about the incumbent tools is the opposite failure: records locked so hard that a
wrong invoice date can never be fixed, and deleting a vehicle destroys its photos.

The right design is neither. It is an **append-only trail with visible corrections** — nothing is
lost, nothing is silently changed, and a mistake can still be put right.

---

## Offline

Drivers work in yards and on highways with no signal, capturing a dozen photos per vehicle plus
signatures. Losing that work is not a degraded experience; it is a lost cargo claim.

**Local-first capture.** Inspections, photos and signatures are written to the device immediately
and queued for upload. Everything needed to complete an inspection is local: VIN validation, check
digit, model year, damage codes, and the barcode decoder itself.

**The WASM is self-hosted** (`public/wasm/`) for exactly this reason. A CDN-loaded decoder means no
scanning in a dead zone, which is where scanning matters most.

**Client-generated UUIDv7 primary keys** let an offline device create records without a round trip.
Version 7 rather than 4 because the leading 48 bits are a timestamp, so keys sort chronologically —
which keeps B-tree inserts at the right edge instead of fragmenting the index, and gives photos a
natural capture order for free.

**Photos are compressed before queueing.** Twelve photos at 1600px and quality 0.8 is a few
megabytes rather than sixty — the difference between a viable upload over LTE and one that never
finishes.

Conflict resolution is the ratchet above: the server wins after finalisation, and the remedy is an
amendment.

---

## VIN handling

Worth its own section because the detail is where reliability comes from.

**Validation is local and instant.** The mod-11 check digit, the model year cycle, and the WMI all
decode with no network. A driver in a dead zone still gets full validation and a make preview.

**A scan is only accepted once the check digit validates.** This is the single highest-leverage
decision in the scanner: a misread barcode almost never produces a valid check digit, so it acts as
free, instant error correction. It turns "scan something and hope" into "scan until provably
correct," which is why scanning can feel reliable even through a dirty windscreen.

**But a failed check digit never blocks a save.** Mis-stamped units, grey imports, kit cars and
state-assigned trailer VINs all fail legitimately. Blocking on it is the most common reason people
abandon a VIN form. It warns; it does not refuse.

**Decoding is proxied and cached forever.** A VIN's manufacturing specification never changes, so
there is no TTL to tune. The proxy exists so results are shared instance-wide, so a fleet of drivers
does not look like one abusive client to NHTSA, and so the upstream host stays fixed.

Four barcode formats are enabled, not twenty. The decoder tries each enabled symbology per frame, so
the restriction is roughly a four-fold throughput gain.

---

## Rendering

Server Components by default. The database is only reachable from the server, and marking it so with
`server-only` turns a mistake into a build error rather than a leaked connection string.

Client Components are used where interaction demands it: the scanner, forms with live validation,
navigation, and animation.

Server Actions handle mutations. Each one re-verifies authorisation itself, because **a Server Action
is a public POST endpoint** — a check on the page that renders the form does not protect it, and a
layout cannot stop a route segment from rendering.

The CSP nonce forces dynamic rendering, which disables static optimisation. For a per-user load
board and inspection app, that costs nothing worth having.

---

## What is deliberately not here

**A load board.** OpenHaul manages what happens after a load is booked. Every major auto-transport
board gates its API behind a paid subscription and a business agreement, and scraping is both a
terms violation and — as a 2025 consent injunction demonstrated — legally fragile. Import by CSV
and by parsed dispatch sheet are the honest paths.

**Telemetry.** The application makes no outbound request the operator did not initiate. The only
third parties are NHTSA and FMCSA, both triggered by an explicit lookup.

**Continuous GPS.** Location is captured at events — pickup arrival, signature, delivery. That is
what the evidence needs. Continuous breadcrumbs are a privacy liability, a battery complaint drivers
actually uninstall over, and in some jurisdictions an enforcement risk.

**A microservice boundary.** One process, one database file. A ten-truck carrier should not have to
operate a distributed system to print a bill of lading.
