# TH MES Ticket

Independent MES feedback and ticket workspace for https://mes.th.io.vn. Repository: https://github.com/TuanPham0411/TH-MES.Ticket. Split from Thien-Ha at `66aa6e527d496679e3941eae02587e17660940ff`. No portfolio frontend or externally hosted Firebase/Supabase service is needed.

## Included

Existing owner/admin/user account management, mandatory incident time and image/video evidence before ticket publication, private pending tickets, ticket history/search, combined incident timeline with personal colors, compact dashboard and widget settings, rich feedback, notifications/templates/scheduling, optional browser notifications, content tabs and internal links, uploads/media, optional Google Drive storage and OAuth. Core behavior is preserved. Quick Access remains removed.

## Build and test

Use Node.js 22.12+ and PostgreSQL 17. Run `npm ci`, `npm test`, `npm run build`. Run `npm run test:integration` with `TEST_DATABASE_URL` pointing to a disposable `_test` database. The integration suite preserves the legacy shared migration behavior; its combined mode exists only for compatibility checks. The production launcher and default backend serve MES only and reject `/api/portfolio`.

## Docker

Copy `.env.example` to a private `.env`. Set `MES_ORIGIN=https://mes.th.io.vn`, separate generated hexadecimal operator/runtime database passwords and the intended owner email. Run `docker compose up -d --build` after the replacement server is ready. The image is `ghcr.io/tuanpham0411/th-mes-ticket:latest` or an immutable commit tag, published for AMD64 and ARM64. The service binds loopback **8082**; database and media use separate persistent volumes.

Set Google callback `https://mes.th.io.vn/api/oauth/callback`; optional Drive callback is `https://mes.th.io.vn/api/mes/drive/callback`. Drive credentials remain in private persistent storage. To activate a fresh initial owner, use an operator connection and `npm run bootstrap:owner`; the printed activation link is private and expires in 72 hours. This does not reset an existing owner.

## Portable scope

Tickets/accounts/dashboard/notifications/local storage run in the unprivileged container. Physical Wi-Fi changes, mounted disk administration and host backup brokers require separately reviewed RPI host integrations; the container does not get host root privileges. `docs/LEGACY-STANDALONE.md` records original portable behavior. Full versioned SQL history is retained for existing-data compatibility, including historical unused portfolio tables; the MES HTTP service does not expose them. No import from another repository is used at build/runtime.

## Prepared release

Main pushes test/build on GitHub-hosted runners, package a checksummed source archive and Linux ARM64 bundle with Node.js 22, and publish Docker images. Artifacts are retained 30 days. No automatic production deployment or self-hosted job is enabled. See [replacement-server guide](docs/REINSTALL.md) and [release usage](RELEASE-README.md). Back up existing database, media, Drive mappings and private configuration outside the RPI before reinstalling it; they are not in the source/image.


## TH-Server managed storage

The optional `storage.compose.yaml` enables the canonical TH-RPI.Server broker.
Application SQL transactions are acknowledged by Drive before committing the local
PostgreSQL projection. Unchanged reads stay local. SQL function writes, background
jobs and metadata changes use the same capture protocol. Each application has a
separate broker credential, database and files volume. Do not copy Drive OAuth tokens
into this repository or switch a provider manually.

The managed deployment workflow runs only after a successful trusted main build. It
uses the deployment implementation pinned from TH-RPI.Server, retains existing
volumes and .env, creates a local database backup, uploads a Drive baseline and
verifies application readiness. A failed migration keeps the maintenance fence and
backup for operator recovery instead of silently accepting unsynchronized writes.
