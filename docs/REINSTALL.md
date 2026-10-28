# Replacement TH-Server — deployment is deferred

Repository: TuanPham0411/TH-MES.Ticket. This project builds and packages without executing anything on a self-hosted runner. No production deployment job is enabled.

## Preserve data before reinstalling the old RPI

The GitHub repository, Docker images and build artifacts contain code only. Back up the existing database with pg_dump custom format, the complete media directory with original relative paths, and private environment/OAuth/Drive configuration to storage outside the SD card. Verify those backups before erasing the old machine. Do not upload them to public repositories or public build artifacts. Drive-hosted media additionally needs its mappings and secure reconnection to the same Drive account.

## Fresh installation later

1. Install a supported 64-bit RPI OS, Docker Compose, Nginx and Cloudflare Tunnel. Create new runner registrations only when deployment is enabled later; old runner registration tokens are not included.
2. Clone this repository, copy .env.example to a private .env and generate distinct database passwords. Set the public origin and optional service credentials.
3. Run `docker compose up -d --build` only after authorizing the actual deployment. Every project has independent database/media volumes. Host loopback port: 8082. Never run `docker compose down -v` against data to keep.
4. Route the corresponding domain through Nginx to this loopback port; Cloudflare Tunnel points to Nginx, preserving Host. No database port is published.
5. Check frontend, API health, login and media before switching DNS. Configure OAuth callback URIs for the individual hostname. Do not share session cookies across apps automatically.

## Restore existing application data

MES retains its complete versioned migration history to support existing tickets/accounts. Restore the old consistent database dump and media backup into the MES instance before applying pending migrations. Historical portfolio tables in the old dump are not served by the MES runtime; retain the backup until the independent portfolio restore is verified. Preserve ticket IDs, evidence paths, notification settings and Drive mappings.

Production secrets stay outside Git. Preserve originals until the restored service has passed verification.
