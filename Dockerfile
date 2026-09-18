# syntax=docker/dockerfile:1

# Debian slim rather than Alpine. `@node-rs/argon2` is a native module and, as
# SELF_HOSTING.md says, the musl prebuilds are the less well-tested path — a
# sign-in that fails to hash is not a thing to discover in production.
#
# Node 24 to match what CI builds and tests against.

# ---- build ------------------------------------------------------------------

FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Everything at once rather than package files first. It costs the layer cache
# on source edits, but the postinstall step copies the barcode decoder WASM
# into public/, and a stage that has package.json without the rest of the tree
# produces an image where scanning silently fails — which is already an entry
# in this project's own troubleshooting notes.
COPY . .

RUN npm ci && npm run build

# ---- runtime ----------------------------------------------------------------

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

RUN useradd --system --create-home --uid 10001 openhaul

# The whole tree, dev dependencies included, deliberately.
#
# `npm prune --omit=dev` is the usual move here and this project has already
# been bitten by it: npm dropped @emnapi/core and @emnapi/runtime on Linux and
# broke CI until they were pinned into `dependencies`. Dependency pruning on a
# tree with native and wasm packages in it is a footgun, and a few hundred
# megabytes is a cheap price for an image that starts.
COPY --from=build --chown=openhaul:openhaul /app /app

# Database, generated documents and inspection photos all live here — the blob
# store defaults to data/uploads — so one volume covers everything that must
# survive a redeploy.
#
# Emptied first, not just created. `next build` imports the route modules, and
# importing src/lib/db/client.ts opens a connection, so the build stage leaves
# an empty data/openhaul.db behind at the default path. .dockerignore keeps the
# real database out of the context; this is the build making its own.
#
# It matters because Docker seeds an empty named volume from whatever the image
# has at the mount point, so that stub would be copied into a fresh deployment's
# volume. SQLite treats a zero-byte file as an empty database and migrates it
# happily, so nothing breaks today — but an image that ships a database file at
# all is one build step away from shipping a populated one.
RUN rm -rf /app/data && mkdir -p /app/data && chown -R openhaul:openhaul /app/data
VOLUME ["/app/data"]

USER openhaul
EXPOSE 3000

# /api/ready, not /api/health. The cheap one answers 204 without touching the
# database, because the offline outbox uses it to spot a captive portal — so a
# container with an unreadable database passes it while being unable to serve a
# page. `curl` is not in the slim image; Node's global fetch is.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrate, then serve. `db:migrate` takes its own backup first and prints the
# rollback command on failure, and `&&` means a failed migration stops the
# container rather than serving against a half-applied schema.
#
# This assumes one instance, which is the deployment this application is for.
# Running several replicas against one SQLite file is not supported, and the
# migration would be the least of the problems.
CMD ["sh", "-c", "npm run db:migrate && npm start"]
