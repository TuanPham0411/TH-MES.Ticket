# TH-Ticket.Ticket: offline-ready ARM64 release

This archive contains the compiled web/API, SQL migrations and the checksum-verified official Node.js 22 Linux ARM64 runtime. It contains no production data, environment secrets or runner registrations. Source revision is in the artifact name. Verify its .sha256 before extraction. Do not deploy until the replacement TH-Server is provisioned.

Set a private runtime environment and initialize/restore the dedicated PostgreSQL database before starting. Read README.md and docs/REINSTALL.md in the source archive. For this release, migrate with `runtime/bin/node dist/server/migrate.cjs` using an operator connection.

Start API with `runtime/bin/node start.mjs` using the runtime connection. The launcher serves web and API together. Docker is the recommended independent deployment path; its AMD64/ARM64 image is published separately.
