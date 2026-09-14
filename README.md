<div align="center">

<img src="public/icons/icon-192.png" alt="" width="72" height="72">

# OpenHaul

**Auto transport load management that you host, own, and can walk away with.**

Scan VINs with a phone camera, build legally-sound electronic bills of lading, prove vehicle
condition with timestamped photos, and invoice the broker — from one app on your own server.
No per-truck fees. No vendor holding your paperwork.

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

</div>

---

## Why this exists

A five-truck car hauler realistically pays for two subscriptions at once — a load board and a
carrier TMS — because neither network is sufficient alone. At advertised list prices that is
roughly **$445 a month, about $5,300 a year**, before the add-ons. And the things most likely to
be paywalled are the ones you would actually want: API access, accounting export, EDI.

The pricing model is the part that stings. Per-seat billing means hiring a driver raises your
software bill. A solo owner-operator and a six-person shop pay wildly different amounts for
identical software.

Then there is the part nobody advertises. Carriers report accounts cancelled without notice.
Boards where a stolen vehicle produced a closed case and no investigation. Two rounds of forced
UI migration in under a year. A court-ordered injunction that permanently removed the largest
load board from one TMS's "all your boards in one place" promise — carriers who bought it
specifically to avoid tab-switching lost that workflow by litigation, not product choice.

Underneath all of it sits a simple asymmetry: **import is documented lavishly, export is an
afterthought.** Your bills of lading are the evidence you need for at least nine months of cargo
claim exposure, and they live somewhere you do not control.

OpenHaul is the other option. Unlimited drivers and dispatchers, because seats are not a product.
Your database on your disk. A one-click export of everything. AGPL-3.0, so it cannot be taken
private and resold back to you.

> **It is not a load board.** OpenHaul does not replace access to Central Dispatch or any other
> marketplace. It replaces the software that manages what happens after you book the load.

---

## What it does

### VIN scanning that works in a yard

Point the camera at the door jamb or windshield label. It reads **Code 39** (the AIAG standard on
vehicle labels), **Code 128**, **Data Matrix** and **QR**, strips the AIAG "import" prefix, and
handles pre-1981 VINs that have no check digit at all.

The part that makes it reliable: **a scan is only accepted once the mod-11 check digit validates.**
A misread barcode almost never produces a valid check digit, so this is free, instant error
correction — it turns "scan something and hope" into "scan until provably correct."

The decoder is WebAssembly served from your own origin, so **scanning works with no signal.**
Safari ships no `BarcodeDetector` and every iOS browser is WKWebView underneath, so the native
path is treated as an optimisation, never a requirement.

Year, make and model then fill in from the free [NHTSA vPIC API][vpic], cached forever because a
VIN's manufacturing specification never changes.

### Condition reports that win claims

Under the Carmack Amendment a shipper makes its case by showing the vehicle went onto the truck in
good condition. **The pickup inspection is the only record that answers that.** A missing or sloppy
one means the carrier eats whatever is found at delivery.

So inspections are built as evidence:

- Guided photo walk-around in the order the AIAG standard prescribes — rear, each side back to
  front, front, interior — with the minimum shot count enforced per tier.
- Full **AIAG M-22 damage coding**: five digits for area, type and severity, with the 2023 area
  table including the EV additions (high-voltage battery, charging cable, thermal event).
- The **non-transportation damage list**, surfaced at inspection time. A driver who tags a paint
  run as carrier damage has opened a claim against their own company.
- Original photo bytes kept immutable and hashed; only stripped, re-encoded derivatives are served.
  EXIF timestamp and GPS are extracted into columns first, because that metadata *is* the evidence.

### Bills of lading that hold up

Every field [49 CFR 373.101][373] requires, issued as a **non-negotiable straight bill** — which
keeps you clear of the UCC 7-106 "authoritative copy" obligations a negotiable document would
trigger.

Signatures record the authentication method, the SHA-256 of the exact bytes shown on screen,
stroke timing, GPS, IP, and both server and device clocks. That list is not paranoia: courts have
rejected electronic signatures backed by a name, a timestamp and the words "(Electronic Signature)"
because nobody could explain the security procedure linking the signature to the person.

The rendered PDF is **frozen and hashed at finalisation.** Regenerating a 2026 bill from a 2033
template does not reproduce the record that was actually agreed.

### The rest

| | |
|---|---|
| **Dispatch** | Multi-stop runs across a 7–10 car deck, weight budget as well as slot count, inoperables flagged before the driver finds out on site |
| **Invoicing** | Built from the load, with broker rate and margin stored as structured fields and a one-click [49 CFR 371.3][371] transaction record |
| **Claims** | State machine with the [49 CFR 370.9][370] deadlines as real dates — 30-day acknowledgement, 120-day resolution — because most small carriers blow the first one |
| **Insurance** | Certificate tracking with expiry alerts. Cargo cover for general freight is **not** filed with FMCSA, so an uploaded certificate is the only way to verify it |
| **Offline** | Inspections, photos and signatures captured on device and queued for upload |

---

## Quick start

Requires **Node 20.9+** (24 LTS recommended). Nothing else — no database server, no Docker.

```bash
git clone https://github.com/OWNER/REPO.git openhaul
cd openhaul
npm install
npm run keys:generate   # writes .env.local with fresh secrets
npm run db:migrate      # creates ./data/openhaul.db
npm run dev
```

Open <http://localhost:3000>, click **Start free**, and the first account you create becomes the
owner of a new organisation.

> **Back up `OPENHAUL_KEYS` and `DATABASE_ENCRYPTION_KEY` somewhere safe before you put real data
> in.** Losing them means losing every encrypted field and the database itself. There is no
> recovery path, by design.

### Other commands

```bash
npm run build       # production build
npm start           # run the production build
npm test            # 86 tests
npm run typecheck   # tsc --noEmit
npm run db:generate # regenerate migrations after a schema change
```

See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for putting it on a real server, including the
reverse-proxy headers you must set or sign-in will fail confusingly.

---

## How it is built

| | |
|---|---|
| **Framework** | Next.js 16 (App Router), React 19, TypeScript strict |
| **Styling** | Tailwind CSS v4, OKLCH design tokens, Motion for animation |
| **Database** | SQLite via libSQL, Drizzle ORM — one file you can copy to back up |
| **Auth** | Argon2id, opaque database sessions, TOTP, hand-rolled session layer over vetted primitives |
| **Barcode** | `barcode-detector` over ZXing WASM, self-hosted |

**Why SQLite rather than Postgres.** The target user runs one to ten trucks. "Copy one file to back
up" is a real advantage over "learn to operate a database server," and photos live in object
storage rather than the database, which removes the biggest write-volume driver. Postgres remains
a documented path; the schema is written against a dialect boundary so the move is a config change,
not a rewrite.

**The cost of that choice.** SQLite has no row-level security. So tenant isolation is structural
rather than declarative — see below — and that is not optional, it is the price of the default.

---

## Security

Full detail in [SECURITY.md](SECURITY.md). The parts worth knowing up front:

**Tenant isolation is enforced three ways, not one.**

1. A scoped query client that **cannot be constructed without an organisation id.** Feature code
   never holds a raw database handle; an ESLint rule blocks the import.
2. **Composite `(org_id, id)` foreign keys**, so a bill of lading in one organisation physically
   cannot reference a load in another. This holds even when application code is wrong.
3. A test that fails when a new table appears in neither the scoped registry nor a documented
   exemption list — because the real risk is the table somebody adds in six months and forgets.

**Personal data is sealed per subject.** AES-256-GCM with HKDF-derived per-purpose subkeys, and
additional authenticated data bound to `(key version, org, table, column, row)`. That last part
matters: without it, anyone who can write one column could copy an encrypted licence number from
one driver's row into another's and it would decrypt cleanly.

It also means an **erasure request can destroy one person's key** without touching the bills of
lading you are legally required to keep. The document's hash stays valid, the audit chain stays
intact, and the personal data becomes unreadable — including in backups, which a `SET column = NULL`
would never reach.

**The audit log is hash-chained.** Every entry commits to the hash of the one before it, with
append-only triggers on top. Verification is one button in settings and names the exact entry where
a chain breaks.

> Triggers stop the application and a careless operator. They do not stop someone with write access
> to the database file, who can drop them. The chain is what *detects* that — and only if you
> export the head hash somewhere you do not control. The app tells you this rather than implying
> the triggers are the protection.

**Passwords** use Argon2id at m=19456, t=2, p=1 — the OWASP configuration that fits a small VPS,
since the 46 MiB alternative multiplies by concurrent sign-ins.

**Sessions are opaque and stored as a hash**, so a database leak yields no usable sessions. Timeouts
are role-aware: a dispatcher at a desk gets 8 hours, a driver gets 30 days. That is deliberate — a
driver in a canyon with no signal *cannot* re-authenticate, and forcing it means either lost
inspection data or passwords written on the dash. The compensating controls are immediate
revocation, a device list, and step-up MFA on anything sensitive.

Found a vulnerability? See [SECURITY.md](SECURITY.md). Please do not open a public issue.

---

## Compliance

OpenHaul is a tool, not legal advice, and **you are the data controller** for your instance. What it
does is make compliance possible rather than something you reconstruct afterwards.

| Reference | What the app does |
|---|---|
| [49 CFR 373.101][373] | Every required bill of lading field, enforced non-null |
| [49 CFR 390.32][390] | Electronic documents and signatures, expressly permitted for motor carriers |
| UCC Article 7 | Non-negotiable straight bills, adopted in all 50 states |
| [15 U.S.C. 7001(c)][esign] | Versioned ESIGN consent captured for individual shippers, stored by hash so the exact text shown is reproducible |
| [49 CFR 370.9][370] | Cargo claim timers at 30, 120, 180 and 240 days |
| [49 CFR 379 App. A][379] | Retention anchored **per record class**, not to a single `created_at` |

That last row is the one most systems get wrong. A single driver's data spans at least eight
retention regimes that run from **different anchor events** — date of execution, date of receipt,
date the vehicle left the carrier's control. Anything keyed off one timestamp is wrong somewhere.

The regulatory floor for a bill of lading is one year. OpenHaul defaults to **seven**, because
Carmack allows a claim up to nine months after delivery and suit two years after denial, and state
contract limitations run longer still. The floor is configurable; going below the regulatory
minimum is not.

**Driver location** is captured at events — pickup arrival, signature, delivery — rather than
continuously, gated on duty status, with a versioned consent notice. Several states require prior
written notice of electronic monitoring, and a continuous breadcrumb trail is both a privacy
liability and, in Canada, the subject of enforced findings against trucking telematics.

---

## Project layout

```
src/
  app/                  routes: (auth), (app), api
  components/
    marketing/          landing page
    app/                application shell
    scanner/            camera, decode loop, VIN input
    ui/                 design system primitives
  lib/
    vin/                check digit, model year, NHTSA client
    aiag/               M-22 damage code tables
    db/                 schema, scoped client, columns
    auth/               password, session, MFA, capabilities
    crypto/             field encryption, blind indexes
    audit/              hash chain
    security/           rate limiting
drizzle/                generated migrations + hand-written triggers
docs/                   architecture, self-hosting, data model
```

Further reading: [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [DATA_MODEL.md](docs/DATA_MODEL.md) ·
[SELF_HOSTING.md](docs/SELF_HOSTING.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Status

Working today: VIN scanning and decode, loads and vehicles, organisations and roles, the security
and audit foundations, and the marketing site.

Being built: the guided inspection capture flow, BOL and POD PDF generation, the offline sync
queue, and invoicing. The schema and compliance groundwork for all of it is already in place —
see [CONTRIBUTING.md](CONTRIBUTING.md) if you want to help.

---

## Licence

[AGPL-3.0-or-later](LICENSE). Run it, change it, keep your data.

The AGPL is a deliberate choice rather than a default. This project exists because carriers are
paying subscriptions for software that holds their own paperwork hostage. The AGPL means a hosted
version of OpenHaul must publish its changes — so it cannot be quietly turned into the thing it
was built to replace.

**Not legal advice.** Regulatory references are provided with citations so you can verify them with
your own counsel. Verify current figures before relying on them: pricing moves, and so do
regulations.

[vpic]: https://vpic.nhtsa.dot.gov/api/
[373]: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-373
[371]: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-371/section-371.3
[370]: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-370/section-370.9
[379]: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-379
[390]: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-390/subpart-A/section-390.32
[esign]: https://www.law.cornell.edu/uscode/text/15/7001
