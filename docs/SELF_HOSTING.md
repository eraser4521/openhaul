# Self-hosting OpenHaul

OpenHaul is one Node process and one database file. A $5 VPS runs a ten-truck carrier comfortably;
so does an old laptop in the office.

---

## Requirements

- **Node 20.9 or newer.** Node 24 LTS is what CI runs.
- About 1 GB of RAM. Argon2id uses 19 MiB per concurrent sign-in, which is the main driver.
- Disk for the database (small) and inspection photos (not small — budget roughly 14 MB per
  inspection at 12 photos).

No database server. No Docker, unless you want it.

> **Alpine note.** `@node-rs/argon2` is a native module. Prebuilt binaries cover
> `linux-x64-musl`, but a Debian-slim base is the better-tested path.

---

## First run

```bash
git clone https://github.com/eraser4521/openhaul.git openhaul
cd openhaul
npm ci
npm run keys:generate
npm run db:migrate
npm run build
npm start
```

`keys:generate` writes `.env.local` with fresh secrets and `chmod 600`. It refuses to overwrite an
existing file unless you pass `--force`, which would make all existing data unreadable.

### Back up the keys first

```bash
# Store these somewhere that is not the server they protect.
grep -E 'OPENHAUL_KEYS|DATABASE_ENCRYPTION_KEY|PASSWORD_PEPPER' .env.local
```

Losing `OPENHAUL_KEYS` means losing every encrypted personal-data field. Losing
`DATABASE_ENCRYPTION_KEY` means losing the database. There is no recovery path — that is what makes
the encryption worth having.

---

## Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | no | Defaults to `file:./data/openhaul.db` |
| `DATABASE_ENCRYPTION_KEY` | strongly recommended | Whole-file encryption at rest |
| `OPENHAUL_KEYS` | **yes** | `v2:<base64>,v1:<base64>`, newest first |
| `OPENHAUL_INDEX_KEY_VERSION` | yes | Pinned separately; rotating it requires re-indexing |
| `PASSWORD_PEPPER` | recommended | Held outside the database |
| `SMTP_HOST`, `SMTP_FROM` | to send documents | Without both, sending is off and the app says so |
| `SMTP_PORT` | no | Defaults to 587. TLS is implied on 465 |
| `SMTP_USER`, `SMTP_PASSWORD` | if your server needs them | Omit for an unauthenticated relay |
| `SMTP_SECURE` | rarely | Derived from the port; set only to override |
| `SMTP_REPLY_TO` | no | Where replies should land, if not the from address |
| `IMAP_HOST` | to read bounces | Without it, a send that failed downstream keeps reading as accepted |
| `IMAP_PORT`, `IMAP_MAILBOX` | no | Default to 993 and INBOX |
| `IMAP_USER`, `IMAP_PASSWORD` | no | Fall back to the SMTP credentials |
| `SMTP_BOUNCE_ADDRESS` | recommended | A plus-addressable mailbox, so bounces can be traced to a send |
| `BOUNCE_CHECK_TOKEN` | for unattended checks | Enables `POST /api/bounces/check`; the endpoint is off without it |
| `STATEMENT_RUN_TOKEN` | for scheduled statements | Enables `POST /api/statements/run`; the endpoint is off without it |
| `DUNNING_RUN_TOKEN` | for chasing overdue invoices | Enables `POST /api/dunning/run`; the endpoint is off without it |
| `FMCSA_WEB_KEY` | for carrier lookups | Free key from mobile.fmcsa.dot.gov; without it the lookup screen says so and stays off |
| `NEXT_PUBLIC_APP_URL` | yes | Public origin, used in metadata |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | multi-instance only | See below |
| `ALLOWED_ORIGINS` | behind a proxy | See below |
| `HSTS_HEADER` | no | Defaults to `max-age=31536000` |

---

## Checking for bounces on a schedule

There is no daemon and no queue here, so returned mail is found by polling.
The Documents screen has a button; for unattended checks, set
`BOUNCE_CHECK_TOKEN` and add a cron line:

```
*/15 * * * * curl -fsS -X POST -H "authorization: Bearer $BOUNCE_CHECK_TOKEN"   https://your-host/api/bounces/check
```

Running it more often is harmless — matching is idempotent, and messages are
marked read rather than deleted, because it is your mailbox and not everything
that lands in it is a bounce.

**What this can and cannot tell you.** A delivery status notification is the
only signal a plain SMTP setup produces, so this finds the failures that come
back as one. A message quietly dropped, greylisted into oblivion, or filed as
spam produces nothing to find. A send with no bounce against it is not proof
anybody read it.

---

## Sending statements on a schedule

Same shape, same reason. The cadence — monthly on a day you choose, or weekly
— is set on the Settings screen; what is missing is something to tell the app
what day it is. Set `STATEMENT_RUN_TOKEN` and add a cron line:

```
0 6 * * * curl -fsS -X POST -H "authorization: Bearer $STATEMENT_RUN_TOKEN"   https://your-host/api/statements/run
```

One line covers any cadence. The app works out which scheduled occurrence
today belongs to, and an occurrence runs at most once — so calling it hourly
sends nothing extra, and a retry after a timeout finds the run already
claimed rather than sending everything twice.

**A missed run is not made up.** If the machine was off for a fortnight, one
statement goes out when it comes back rather than a fortnight of them. Every
balance on a statement is as at the moment it was produced, so an occurrence
that was missed has nothing left to say that the current one does not.

**Failures do not stop the sweep.** Each customer is produced and sent on its
own, and whatever went wrong is recorded against that customer: no address on
file, a statement that would not reconcile, a refused recipient. Settings
lists them after every run. Nothing is retried inside a run — an SMTP outage
during a fifty-customer sweep would otherwise become several hundred attempts
against a server already refusing — so a failure waits for a person or for
the next occurrence.

The endpoint returns 200 even when individual sends failed, because the
request was handled and a retry would only find the occurrence taken. Watch
the run summary in Settings, not the HTTP status.

---

## Chasing overdue invoices

Off until you turn it on, and off by default for a reason: a ladder that
starts sending the moment it is deployed chases debts you had already settled
by telephone. Set the rungs on the Settings screen, then set
`DUNNING_RUN_TOKEN` and add a cron line:

```
0 9 * * * curl -fsS -X POST -H "authorization: Bearer $DUNNING_RUN_TOKEN"   https://your-host/api/dunning/run
```

Its own token rather than sharing the statement one. Sending a summary and
chasing a debt are different acts with different consequences, and a carrier
who wants monthly statements but no automatic chasing should be able to have
exactly that without reading the source to find out whether one switch turns
on both.

Daily is the right cadence whatever the ladder says. **At most one rung goes
per invoice per sweep**, so a sweep that has not run for a month finds an
invoice fifty days overdue and sends the first reminder, not all three — a
customer whose first contact about a debt is a final notice has been ambushed,
however late they are.

**What it refuses to chase.** An invoice covered by credit the customer is
holding with you. One with an open cargo claim on its load, or a load under
legal hold. One where money has arrived recently. One somebody has paused by
hand, with a reason, from the invoice screen. A customer who has asked not to
be chased. Anything below the minimum balance. Every refusal is named on the
Settings screen against the invoice it applies to, so "that is ninety days
late, why has nobody chased it" has an answer.

**A promise stops it.** When a customer says when they will pay, record it on the invoice: chasing
stops until that day and a few days after it for the post. If the money arrives the promise closes
itself; if it does not, the next notice states what they told you and when. Only money that arrived
after they said it counts toward it, and a second conversation replaces the first rather than
breaking it — telling somebody they broke their word when they did not is worse than any reminder.

**The wording is yours.** The default rungs threaten nothing — no collections,
no lawyers, no credit rating — because a default that promised any of those
would put words in your mouth about a step you may have no intention of
taking, and a threat you do not follow through on is ignored the next time.
Write your own if you want to name a consequence, and mean it. The figures,
the dates and how to pay are printed by the document; you write the sentence.

---

## Behind a reverse proxy

**This is the step that produces the most confusing failure.** Next.js validates that a Server
Action's `Origin` matches its `Host`. Behind a proxy that rewrites `Host`, every sign-in fails with
no useful message.

Either forward the public host, or list it in `ALLOWED_ORIGINS`.

### Caddy

```caddy
openhaul.example.com {
    reverse_proxy localhost:3000
}
```

Caddy sets the forwarding headers and obtains a certificate automatically. It is the least
error-prone option.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name openhaul.example.com;

    ssl_certificate     /etc/letsencrypt/live/openhaul.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openhaul.example.com/privkey.pem;

    # Inspection photo uploads. nginx defaults to 1 MB, which silently rejects them.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Host  $host;   # required, see above
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
```

**HTTPS is not optional.** `getUserMedia` requires a secure context, so VIN scanning simply does not
work over plain HTTP. Service workers need it too. `localhost` counts as secure for development.

---

## Running as a service

```ini
# /etc/systemd/system/openhaul.service
[Unit]
Description=OpenHaul
After=network.target

[Service]
Type=simple
User=openhaul
WorkingDirectory=/opt/openhaul
Environment=NODE_ENV=production
EnvironmentFile=/opt/openhaul/.env.local
ExecStartPre=/usr/bin/npm run db:migrate
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/openhaul/data /opt/openhaul/.next

[Install]
WantedBy=multi-user.target
```

`ExecStartPre` runs migrations as a one-shot step before the server starts. Never migrate from
inside a request path.

For a stronger secret setup, `systemd-creds` binds an encrypted credential to the host TPM and
exposes it only to this service:

```ini
LoadCredentialEncrypted=openhaul-keys:/etc/openhaul/keys.cred
```

---

## Backups

SQLite makes this genuinely easy, which is most of the argument for it.

```bash
#!/usr/bin/env bash
# /opt/openhaul/backup.sh
set -euo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
DEST=/var/backups/openhaul

mkdir -p "$DEST"

# VACUUM INTO is transactionally consistent. `cp` is not -- it can capture a
# torn write-ahead log and produce a backup that will not open.
sqlite3 /opt/openhaul/data/openhaul.db "VACUUM INTO '$DEST/openhaul-$STAMP.db'"

# Photos and generated documents.
tar czf "$DEST/uploads-$STAMP.tar.gz" -C /opt/openhaul/data uploads

find "$DEST" -name '*.db' -mtime +30 -delete
find "$DEST" -name '*.tar.gz' -mtime +30 -delete
```

For continuous replication, [Litestream](https://litestream.io) streams SQLite to S3-compatible
storage with point-in-time restore.

**Test the restore.** A backup you have never restored is a hypothesis.

```bash
sqlite3 /var/backups/openhaul/openhaul-TIMESTAMP.db "PRAGMA integrity_check;"
```

> Backups taken before a key rotation still need the **old** key to restore. Keep retired keys in
> cold storage for at least your backup retention window before destroying them.

---

## Upgrading

```bash
cd /opt/openhaul
git pull
npm ci
npm run db:migrate   # takes its own backup first
npm run build
sudo systemctl restart openhaul
```

`db:migrate` writes a consistent backup before touching anything and, on failure, prints the exact
command to roll back.

Migrations are committed SQL, generated at development time. **Never run `drizzle-kit push` against
a real deployment** — it diffs live schema and can silently drop columns.

---

## Vercel and similar

The app deploys to Vercel, with caveats worth knowing before you commit to it.

The filesystem is ephemeral, so `DATABASE_URL` must point at hosted libSQL
([Turso](https://turso.tech)) and photos need S3-compatible storage — Cloudflare R2 is a good fit
because egress is free and this application serves a lot of images.

Request bodies are capped at 4.5 MB and it is not configurable, so photo uploads must go direct to
storage rather than through the application.

Self-hosting remains the better default. It is also the point: the project exists so your data sits
where you can reach it.

---

## Health checks

```bash
curl -f https://openhaul.example.com/ || systemctl restart openhaul
```

Verify the audit chain on a schedule and export the head hash somewhere the server operator does
not control. A chain that only exists inside the database it protects proves very little.

---

## Troubleshooting

**Sign-in fails with no message, behind a proxy.** `X-Forwarded-Host` is not set. See above.

**The camera will not start.** The page is not on HTTPS, or the browser has a stored denial.
`getUserMedia` requires a secure context and will not re-prompt after a block — the site settings
have to be cleared manually.

**`SQLITE_BUSY` under load.** Confirm WAL mode is on:
`sqlite3 data/openhaul.db "PRAGMA journal_mode;"` should report `wal`.

**Barcode scanning works locally but not in production.** `public/wasm/zxing_reader.wasm` is
missing from the deploy. `npm ci` runs the copy step via `postinstall`; a partial install skips it.

**Photo uploads fail at exactly 1 MB.** nginx's default `client_max_body_size`.
