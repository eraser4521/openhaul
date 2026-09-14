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
| **Bounces** | Delivery notifications read back out of your mailbox and matched to the send, so a failure downstream stops reading as accepted |
| **Sending** | Over your own SMTP, with the attachment hash-checked first and every attempt recorded — and no claim that anything was delivered |
| **Credits** | A reduction is a second document referencing the invoice, never an edit to the one already sent |
| **Carrier vetting** | Authority, out-of-service status and — for brokers — the surety bond, checked against FMCSA's census and kept as a dated record |
| **Insurance** | Certificates with expiry alerts, and a check of what is on the deck against the cargo limit. Cargo cover for general freight is **not** filed with FMCSA, so the certificate is the only evidence |
| **Expenses** | Fuel, tolls and scales recorded from the cab with the receipt, approved by the carrier, and swept into the next settlement |
| **Import** | CSV and dispatch-sheet exports, mapped column by column and previewed row by row before anything is written |
| **Offline** | Inspections, photos, signatures and expenses captured on device and queued for upload |

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

**Field encryption is AES-256-GCM** with additional authenticated data bound to
`(key version, org, table, column, row)`. That last part matters: without it, anyone who can write
one column could copy an encrypted licence number from one driver's row into another's and it would
decrypt cleanly.

**Personal data gets a key of its own, per person.** A licence number, date of birth or home
address is never inlined on the driver row — it lives in a vault sealed under a data key belonging
to that one individual, and that key is **random and stored only wrapped**, never derived. That
distinction is the whole feature: a key derived from the root could be re-derived forever, so there
would be nothing to delete and an erasure request could not be satisfied. A random key that exists
in exactly one place can be destroyed, and destroying it is what makes that person's data
unreadable while the bill of lading, its content hash and the audit chain stay exactly as they
were. Rotating the root re-wraps one short string per person and rewrites no field at all.

Reading personal data is a deliberate act: the screen renders without it, revealing it is a
separate request, and every decrypt lands on the audit chain with who looked and why — never with
the values. Erasing takes a reason and the driver's name typed exactly, because there is no undo
and no copy of the key anywhere in the application.

> **What erasure does not reach.** A backup taken before the erasure still holds the wrapped key
> and the ciphertext together. Erasure is complete only once those have aged out of your rotation,
> and the app says so at the point of erasing rather than letting you assume otherwise. The
> driver's display name also stays in the clear: the app cannot dispatch a load without something
> to call them, and that name is already printed on documents you are required to keep.

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

Returned mail closes half that gap. Point OpenHaul at the mailbox bounces come back to and it reads
delivery status notifications out of it, matches each one to the send it belongs to — by the
returned Message-ID, or by a token carried in the envelope sender for the servers that return
nothing else — and marks the send as bounced with what the receiving server actually said, in plain
English beside the code. A 4.x.x delay is recorded but deliberately not treated as a failure: the
receiving server is still trying, and calling that a bounce would have somebody re-sending a
document that is about to arrive. The other half of the gap does not close: a message quietly
dropped or filed as spam produces nothing to find.

A driver records what they spent from the cab, on the same queue that carries inspection photos —
saved to the phone first and uploaded when there is signal, because a yard with no bars should not
cost a driver the money back. The receipt is optional: a figure with no receipt is weaker than one
with, and far better than nothing written down.

What a driver cannot do is decide what comes back to them. The settlement sweeps up anything marked
reimbursable automatically, which makes that flag an instruction to pay — so recording an expense
leaves it awaiting review and a dispatcher, owner or bookkeeper decides. That gives three states
rather than two, and the distinction matters: "nobody has looked at it yet" and "we looked and said
no" are the same boolean and a driver watching a receipt sit unacknowledged for a fortnight needs to
know which one they are looking at. Once a settlement has paid it, nothing here can change it — a
correction goes on the following statement.

A credit raised after the customer has already paid leaves the carrier holding money that is not
theirs, and a refund is what closes that. It is recorded rather than derived — which invoice, how
much, by what method, and the date the money actually left — because the question asked six months
later is "we sent them $500, against what?" and a computed figure cannot answer it. The credit note
that caused the overpayment is cited where there is one.

A refund **adds back** to the balance rather than reducing what was paid. The customer did pay that
money; modelling the return as a negative payment would say it never arrived, quietly drop recorded
revenue and move the aging report. And the app refuses to send back more than is owed, because
over-refunding turns one mistake into two and hides the second — the invoice then reads as underpaid
and looks like a collection problem rather than an error.

The other way to settle an overpayment is to carry it against the customer's next invoice, which
the credit note offers. That is not modelled: it needs a customer-level credit balance, and half of
one would be worse than none. A carrier taking that route reduces the next invoice by hand.

Insurance is where the authority lookup runs out. Cargo cover for general freight is not filed with
FMCSA, so nothing public says whether the policy that pays for a scratched Porsche exists — the
certificate is the only evidence, for your own cover and for anyone you tender to. Certificates are
recorded with the limit, the deductible and both dates, the PDF itself can be attached, and the
dashboard says when one is about to lapse or already has. A lapsed certificate stays on the list
rather than dropping off it, because a lapse nobody noticed is the worse one.

The check worth having is against the load. A seven-car deck of new vehicles clears $350,000 without
being remarkable, and $100,000 is the cargo limit brokers ask for and therefore the one most
carriers buy — the difference is the carrier's, personally. So the load screen compares the declared
values on the deck against the limit in force and says what the shortfall is. A vehicle with no
declared value makes that **unknown** rather than fine: reporting full cover on the one load nobody
valued is the failure that matters.

What a certificate cannot do is said where it is shown. It records cover on the day it was issued
and is not notice that the policy is still in force — cancellation is silent unless you are a named
certificate holder. Marking one as checked records that a person opened the document and agreed with
the figures, and editing those figures afterwards drops the mark, because a tick that survives a
changed limit is a record of a check nobody performed.

Templates are what make the paperwork yours. Upload a logo, pick a colour, write the standing
notes you put on every job, and they appear on the bill of lading, the invoice, the settlement
statement and the claim letters — set once as a house style, overridden per document where an
invoice needs a remittance line a bill of lading does not. What a template cannot do is the point
of it: there is no field that reaches the terms on a bill of lading, the non-negotiable declaration
on its face, or what a Part 370 claim letter says. Your own terms print after the fixed ones under
a heading naming you, so a shipper reading the page can tell which sentences are the regulation's
and which are yours. A pale brand colour is darkened where it is set as text, because a bill of
lading gets photocopied and faxed and a colour that vanishes on the copy is worse than no colour at
all. A specimen of any document renders from whatever is currently in the form — saved or not —
through the same code the real one uses, so you can try six colours against a bill of lading before
committing to one. And because a document is frozen when it is issued, changing your logo in March
does not put it on a bill of lading signed in February.

The same screen holds your accessorial charges, with a name, a rate and the unit each is counted
in. Picked from that list on an invoice, they print itemised with the arithmetic beside them:
"Detention at pickup — 3.5 hrs at $75.00" gets paid, "Accessorials $262.50" gets a phone call. A
line copies its label and rate at the moment it is added, so raising your detention rate next month
does not rewrite what you charged last month, and the invoice's accessorial figure is always the
sum of its lines rather than a number typed beside them.

Retention is per record class, and the reason is that it cannot be anything else. A bill of lading
runs from the day it was sealed, the photographs run from delivery, a cargo claim runs from the day
it was disallowed, a driver record runs from the day they left — four different events, and anything
keyed off one `created_at` is wrong somewhere. So each class carries its own period, its own anchor,
the regulatory floor it cannot be taken below and the citation for that floor, and the settings
screen shows all four rather than a number you have to trust.

Three things are refused rather than computed. A record with no anchor yet is never due, so an
undelivered load, an open claim and a current driver cannot be destroyed however long they have
existed. A legal hold on the load, the driver or the whole organisation beats every period — filing
a cargo claim places one automatically, and one hold released does not expose a load a second is
still protecting. And a period below the floor is refused with the rule that sets it, rather than
silently accepted.

Nothing runs on a timer. The engine reports; destroying anything is a form somebody fills in, for
one class at a time, after reading how many records go — and the count has to be typed to confirm
it. Even then most classes are never deleted at all: invoices, claims and settlements are reported
only, because "past its retention period" and "should be destroyed" are different statements and
the second one is not the app's to make on a schedule. Driver records point at erasing the personal
data instead, which leaves the record and destroys the key.

What a purge does take is what costs real money and real exposure: sealed PDFs past their period,
and inspection photographs past the window anybody could still use them as evidence in. Those go
with every object behind them — the served copy, the thumbnail, and the original still carrying
EXIF and a GPS fix — and a file two records share is left alone.

Loads already living in a spreadsheet or a board export come in as a file rather than as typing.
Every export names the same twenty things differently, so the columns are guessed from their
headers and the guess is shown with a sample value beside it — an off-by-one column is obvious
when "Pickup City" reads `950`. Rows sharing a load number become one load with several vehicles,
which is how a multi-car order is exported.

Nothing is written until the whole file has been read back to you: what each load would be, and
what is wrong with it. The refusals are the point. Dates are read month-first because these files
come from US boards, and `25/12/2026` — which cannot be read that way — is reported rather than
quietly switched to day-first for one cell. A VIN that fails its check digit imports with a flag,
because it is probably a typo and possibly a genuine oddity. Several VINs in one cell become
several vehicles, and the row's year and make are dropped, because there is no way to tell which
VIN they belonged to and a Tesla recorded as a 2003 Honda is worse than a blank. A load number
already in use is refused outright; a VIN already on an open load is only flagged, because a car
really can move twice.

What the file does not contain is not invented. A venue needs a name, a street, a city, a state
and a postal code, and a board export usually carries a city and a state — so no venue is written,
the stop keeps what was known as a note, and the preview says which of the five are missing. An
invented street would end up on a bill of lading.

**Not built yet.** Nothing on the original list. What is missing now is one thing: carrying an
overpayment against a customer's next invoice rather than refunding it. See
[CONTRIBUTING.md](CONTRIBUTING.md).

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
