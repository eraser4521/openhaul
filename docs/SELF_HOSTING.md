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
| `FMCSA_WEB_KEY` | for carrier lookups | Free key from mobile.fmcsa.dot.gov; without it the lookup screen says so and stays off |
| `NEXT_PUBLIC_APP_URL` | yes | Public origin, used in metadata |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | multi-instance only | See below |
| `ALLOWED_ORIGINS` | behind a proxy | See below |
| `HSTS_HEADER` | no | Defaults to `max-age=31536000` |

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
