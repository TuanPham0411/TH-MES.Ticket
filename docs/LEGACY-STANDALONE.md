# TICKET Ticket — standalone application

TICKET Ticket is the child application of [TH portfolio](https://th.io.vn). Live instance: <https://ticket.th.io.vn>. Canonical source: `ticket/` and the shared `server/` in [Thien-Ha/main](https://github.com/TuanPham0411/Thien-Ha). The generated [`ticket-standalone` branch](https://github.com/TuanPham0411/Thien-Ha/tree/ticket-standalone) is a complete, independently buildable source tree. Make changes in `main`; the export workflow refreshes the generated branch without rewriting its history. `SOURCE.json` records the parent commit. The parent export workflow builds and validates every export; for CI in a separate repository, copy `ci/standalone.yml` to `.github/workflows/build.yml`.

## Deploy with Docker Compose (x86-64 or ARM64)

1. Clone **only** the standalone branch into a new directory:
   ```sh
   git clone --branch ticket-standalone --single-branch https://github.com/TuanPham0411/Thien-Ha.git ticket
   cd ticket
   cp .env.example .env
   ```
2. Edit `.env`. Set the public `TICKET_ORIGIN` (e.g. `https://tickets.example.com`), your owner email, and two distinct random hexadecimal database passwords. Keep `.env` private. Google login, Drive and translation keys are optional. Do not use the sample passwords.
3. Run `docker compose up -d --build`. PostgreSQL initializes a restricted `th_api` runtime role; the one-off migration service uses the operator connection, then the web service starts. Database and files have separate persistent volumes. No existing Pi database or media is copied by this deployment.
4. Configure your HTTPS reverse proxy or Cloudflare Tunnel to send this hostname to **HTTP 127.0.0.1:8080**. If the tunnel runs in another container, use the Docker service address `http://ticket:3000` on the same private network. See `nginx.conf.example` for an origin proxy template. Do not expose the database port. Allow at least 200 MB/video, sufficient upload timeouts, and HTTP Range requests. Camera access requires HTTPS; do not disable camera permission in proxy headers.
5. Check `https://YOUR_HOST/api/health`. To activate the initial owner, run:
   ```sh
   docker compose run --rm migrate node dist/server/bootstrap-owner.cjs
   ```
   Open the printed **private** link and set a password for `hpham`. The link expires in 72 hours. This command refuses to reset an already activated owner. Never publish its output. Alternatively configure Google OAuth and sign in with `OWNER_EMAIL`.
6. If using Google, register `TICKET_ORIGIN/api/oauth/callback`. For Drive also register `TICKET_ORIGIN/api/ticket/drive/callback`. API keys and tokens stay in backend environment/persistent storage.

For updates, back up both volumes, pull the branch, then run `docker compose up -d --build` again. Existing volumes are retained and versioned migrations are applied once. Do not run `docker compose down -v` against a deployment with data.

## Other Node/Docker platforms

Use Node.js 22+, PostgreSQL 17 with pgcrypto and a persistent writable disk. Run `npm ci && npm run build`; run `npm run migrate` **once as a migration/operator role** with `DATABASE_URL`; then start with a restricted `th_api` database URL using `npm start`. Configure `TICKET_ORIGIN`, `DATABASE_URL`, `PORT`, `FILES_ROOT` and `DRIVE_TOKEN_FILE`. `HOST` defaults to `0.0.0.0` in the standalone launcher. Mount persistent storage at `/data` or set explicit persistent paths. HTTPS is required except loopback development origins. Set `TRUST_PROXY` only for your actual proxy network; never expose an unprotected trusted-proxy listener directly to the Internet.

The app serves both the built frontend and same-origin `/api`; ticket/page deep links work. No portfolio frontend, portfolio HTTP API, Firebase or Supabase service is required. Shared migration history currently creates unused portfolio tables too; retain these migrations to preserve compatibility. Static-only hosts (GitHub Pages, Netlify static, Vercel static) require a separately hosted API with a same-origin proxy; uploading only `ticket/dist` does not provide authentication or storage.

Core accounts, ticket CRUD/history, comments, dashboards, content tabs, personal settings and local media work on the portable server. Direct Drive uploads/reads need OAuth and persistent token storage. **USB discovery/mounting, physical database relocation and the Pi backup/Drive bulk-transfer broker remain Raspberry Pi host integrations**, and are not provided by this unprivileged container. On other platforms use their disk/backup facilities; do not mount host devices or grant a privileged container just to enable these controls.

## Move existing data

The standalone branch contains source only. To move a live instance, schedule a write pause; take a PostgreSQL custom-format dump and a complete media copy with original paths; restore them into the target database/media volume, run pending migrations, then verify ticket IDs, history, file links and range playback before switching DNS. If files are on Google Drive, preserve the cloud mappings and securely reconnect the same Google account (or transfer the private token file separately). Existing SD/USB storage broker mappings need to be flattened into the portable media root. Keep the Pi and its backups intact until the new instance is verified. This export does not migrate or delete live data.
