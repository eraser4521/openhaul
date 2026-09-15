# Contributing

Domain knowledge is worth more here than code. If you have hauled cars, dispatched, or fought a
cargo claim, a description of how the work actually goes is the most valuable thing you can open.

---

## Getting set up

```bash
git clone https://github.com/eraser4521/openhaul.git openhaul
cd openhaul
npm install
npm run keys:generate
npm run db:migrate
npm run dev
```

Before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
```

---

## Where help is most useful

**Promises to pay.** When a customer says "the cheque goes out Friday", the only place to put that
today is a dunning pause with a reason. What it should be is a record with a date and an amount
that the ladder watches: kept, and the customer is left alone; broken, and chasing resumes knowing
it was broken. That changes what the next letter can honestly say, which is the point.

**Correctness in the domain.** If a damage code, a retention period or a workflow assumption is
wrong, say so — ideally with the citation. Being wrong about 49 CFR is worse than being ugly.

---

## House style

The code is written to be read by someone who has to fix it at 2am.

**Comment the why, never the what.** `// increment i` is noise. `// Rotating this invalidates every
blind index` is the comment that stops someone breaking production a year from now.

**Name the constraint in the comment.** Prefer "SQLite defaults foreign_keys to OFF, which would
make every composite key decorative" over "enable foreign keys."

**Say what a thing costs.** If a decision has a downside — nonces disable static rendering, blind
indexes leak equality, triggers do not stop someone with file access — write it down. A codebase
that only documents its strengths is not trustworthy.

**Match the surrounding code.** Comment density, naming, and idiom should look consistent; a file
should not announce which contributor wrote it.

Practical rules:

- TypeScript strict. No `any` without a comment explaining what forced it.
- Money is integer cents, suffixed `Cents`. A test enforces this.
- Never import the raw `db` handle outside `src/lib/db/**`. Use `forOrg()`.
- Every Server Action calls `requireCapability` itself. It is a public POST endpoint; the page that
  renders the form does not protect it.
- Never log decrypted personal data, and never put it in the audit log.

---

## Tests

Vitest, in `tests/`. The bar is not coverage percentage; it is whether the test would have caught a
real bug.

The existing suite is a reasonable guide to what is worth testing:

- **VIN validation** uses fixtures verified against NHTSA's live validator — including that NHTSA's
  own documentation sample fails its own check digit, which is used as a negative case.
- **The crypto tests** assert that a ciphertext moved to another row, column, table or organisation
  fails to decrypt. One of them found a real bug: a subkey cache keyed on version but not on the
  root key, which would silently hand a second keyring the first one's derived key.
- **The tenant registry test** fails when a new table with an `org_id` is not accounted for. It is
  the test most likely to save someone.

If you fix a bug, add the test that would have caught it.

---

## Commits and pull requests

Explain **why**, not what — the diff already shows what. A message that says "the effect that
kicked off the decode also wrote to the rows it depended on, so its cleanup cancelled the request"
is worth ten that say "fix VIN decode."

One concern per pull request. Mention it in an issue first if it is large, so nobody duplicates
work.

---

## Legal and regulatory content

Cite the regulation. `49 CFR 373.101`, not "DOT requires."

Do not state a legal conclusion the project cannot stand behind. The framing throughout is: here is
the requirement, here is the citation, verify it with your own counsel. Keep it that way.

Regulations and vendor pricing both move. If you notice something has gone stale, updating it is a
genuinely useful contribution.

---

## Licence

Contributions are licensed under [AGPL-3.0-or-later](LICENSE), same as the project.

The AGPL is deliberate. This exists because carriers pay subscriptions for software that holds their
own paperwork hostage; the AGPL means a hosted version must publish its changes, so it cannot
quietly become the thing it was built to replace.
