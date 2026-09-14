<div align="center">

<img src="public/icons/icon-192.png" alt="" width="72" height="72">

# OpenHaul

**Auto transport load management that you host, own, and can walk away with.**

Scan VINs with a phone camera, build legally-sound electronic bills of lading, prove vehicle
condition with timestamped photos, and invoice the broker — from one app on your own server.
No per-truck fees. No vendor holding your paperwork.

[![CI](https://github.com/eraser4521/openhaul/actions/workflows/ci.yml/badge.svg)](https://github.com/eraser4521/openhaul/actions/workflows/ci.yml)
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
| **Claims** | Statutory deadlines as real dates — [30-day acknowledgement][370-5], [120-day disposition and 60-day status letters][370] — because most small carriers blow the first one |
| **Settlements** | Per-load pay with the arithmetic shown, itemised chargebacks, and escrow accounted for across periods — the things [49 CFR 376.12][376] requires of a lease |
| **Sending** | Over your own SMTP, with the attachment hash-checked first and every attempt recorded — and no claim that anything was delivered |
| **Credits** | A reduction is a second document referencing the invoice, never an edit to the one already sent |
| **Carrier vetting** | Authority, out-of-service status and — for brokers — the surety bond, checked against FMCSA's census and kept as a dated record |
| **Insurance** | Certificate tracking with expiry alerts. Cargo cover for general freight is **not** filed with FMCSA, so an uploaded certificate is the only way to verify it |
| **Offline** | Inspections, photos and signatures captured on device and queued for upload |

---

## Quick start

Requires **Node 20.9+** (24 LTS recommended). Nothing else — no database server, no Docker.

```bash
git clone https://github.com/eraser4521/openhaul.git openhaul
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
npm test            # 135 tests
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
| [49 CFR 370.3][370-3] | The three things that make a written communication a claim, and what does not |
| [49 CFR 370.5][370-5] | Written acknowledgement of a cargo claim within 30 days |
| [49 CFR 370.9][370] | Disposition within 120 days, then a status letter every 60 |
| [49 CFR 376.12][376] | Truth-in-leasing: chargeback itemisation, escrow accounting, the 15-day payment window |
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

**Working today.** VIN scanning and decode. Loads, vehicles, route and customers. Organisations
and roles. The security and audit foundations. The full inspection flow: guided walk-around
capture, on-device compression, AIAG damage coding, signature capture with stroke data, content
hashing, and sealing. Bill of lading and delivery receipt generation. Invoicing, from raising an
invoice off a delivered load through to recording payment. Cargo claims, from intake through to a
written disposition. FMCSA carrier and broker lookups. Driver settlements, including the
truth-in-leasing disclosures a leased owner-operator is owed. Credit notes against an issued
invoice. Sending any of it by email, over your own mail server. The offline queue behind it. The
marketing site.

The inspection path is verified end to end against a running instance — a 2.2 MB photo compresses
to roughly 300 KB on the device, uploads, and is stored as an immutable original plus a stripped
derivative and a thumbnail. The signature's `document_sha256` matches the inspection's content hash
exactly, so the signature provably commits to the record that was on screen. Once sealed, both the
API and the database refuse to change it.

The document path is verified the same way. A bill of lading cannot be issued until every vehicle
has a sealed pickup inspection and the load has an origin and a destination; when something is
missing the app names the field and cites 49 CFR 373.101 rather than producing a document with
blanks in it. Issuing renders the PDF, hashes it, and stores the bytes — those bytes are the
record, not the rows they came from. Reissuing supersedes rather than replaces, so the copy
somebody signed stays retrievable. Every view re-checks the stored file against the hash recorded
at signing; a single flipped byte is refused with a 409 and written to the audit chain instead of
being served.

Invoicing follows the same shape. An invoice is raised from a load that already has a signed
delivery receipt, priced from the rate on file, and it says out loud which figure it took — the
carrier rate or the customer tariff — because billing the wrong one is a five-figure mistake. It
is editable while it is a draft and frozen the moment it is issued, at which point the payment
clock starts from the terms. The PDF cites the bill of lading and delivery receipt by number and
hash, so a broker's accounts department can check the attachments rather than trust them, and a
factored invoice carries its Notice of Assignment on the face where a factor will accept it.
Payments are recorded against the invoice and the paid total is rebuilt from those rows every
time, so a corrected payment cannot leave a stale figure claiming an invoice is settled. The
receivables view ages by how late payment is, not how old the invoice is.

Claims are where the inspection record finally earns its keep. Filing one puts the load's records
on legal hold so retention cannot age out the evidence, and the screen assembles what the shipper
has to prove under Carmack — condition at origin, condition at destination, and the difference
between them, matched on AIAG code so the same dent reported at both ends is not counted as new.
The deadlines are computed from the date the claim was *received*, not the date somebody typed it
in, because a claim that sat in an inbox for a fortnight has already spent half its acknowledgement
window. OpenHaul writes the three letters Part 370 requires and freezes each one; it does not send
them, and it says so.

The FMCSA lookup is the one place where being careful about what the data *cannot* say matters more
than the lookup itself. Cargo insurance for general freight — which includes vehicles — is not filed
with FMCSA at all, so "no cargo insurance on file" is the normal state of a fully insured car hauler
and flagging it would condemn the entire industry. It is reported as a limit of the source instead,
alongside the reminder that registration is not a credit check. What the check *does* answer is
whether they may operate today, and, for a broker, whether the $75,000 surety bond that stands
between you and an unpaid invoice is actually on file. Every result is stored, because "we checked
their authority before we tendered" is a defence and remembering that somebody looked at a screen
is not.

Settlements are where 49 CFR Part 376 bites, and only for a leased owner-operator — a company
driver is on payroll and the part does not apply, so their statement does not pretend it does. For
a lease, the statement shows the rated revenue each percentage was taken from ([376.12(d)][376]),
names every item charged back rather than printing one "deductions" total and tells the driver they
may examine the documents behind any of it ([376.12(g)][376]), carries a running escrow balance
across every settlement with the right to demand an accounting ([376.12(h)][376]), and states the
fifteen-day payment window ([376.12(f)][376]) — after which the settlement is flagged as late. A
load is picked up by exactly one settlement, dated by delivery rather than dispatch, and the totals
are only ever a projection of the lines printed beneath them.

A credit note is the last piece, and it exists because voiding stops being available the moment a
payment lands — voiding then would erase money actually received. So a reduction is a second
document that references the first. The invoice keeps saying what it said, because the customer is
holding it; only the balance moves, and the credit note says so on its face. It also says, in
capitals, that it is not a bill: accounts payable departments process by document type, and a
credit that reads like an invoice gets paid instead of applied. When a cargo claim is settled by
coming off the freight bill rather than being paid out, the claim number goes on the credit note.

Sending goes over SMTP through whatever mailbox you already have, because a vendor API would be
less code here and a subscription for you. The covering email is drafted from the record — the
customer for an invoice, the claimant for a claim letter, with the amount, the due date and the
notice of assignment already in it — and every field is editable before it goes. The PDF is checked
against the hash it was sealed under before it is attached, so a file that no longer matches is
refused rather than mailed out of the building.

What it will not tell you is that anything arrived. A mail server accepting a message is not
delivery and is certainly not proof of reading, so the app says only that the message was handed
over, records every attempt with the hash of what was attached, and suggests you keep your own
proof of sending where a date decides something. Nothing tracks opens.

**Not built yet.** Nothing on the original list. What is missing now is smaller and specific: a
payment-out to close a refund, driver expense capture from the cab, and letterheaded document
templates. See [CONTRIBUTING.md](CONTRIBUTING.md).

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
[370-3]: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-370/section-370.3
[370-5]: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-370/section-370.5
[376]: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-376/subpart-B/section-376.12
[379]: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-379
[390]: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-390/subpart-A/section-390.32
[esign]: https://www.law.cornell.edu/uscode/text/15/7001
