# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- Negative caching no longer remembers `403` (the plugin's answer to a refused `User-Agent`, which one client could
  otherwise make every app see) or `401` in a scope shared by a player's devices.
- Without `MCD_JWT_SECRET`, `public` answers are no longer stored per unverified token, so random tokens cannot fill the cache.
- On a cache miss the plugin is asked only with the canonical languages; answers that `Vary` on other headers are not stored.
- Refused WebSocket upgrades close the socket at once instead of leaving it half open.
- The tunnel's WebSocket reader refuses fragmented or oversized control frames and out-of-order fragments, and copies a
  large frame once instead of on every chunk.
- Response header values that a client may not receive are dropped instead of being cached.
- The Docker image keeps the admin port on loopback (set `ADMIN_HOST=0.0.0.0` to scrape it from another container).

### Fixed
- `mcdp_rejected_total` counts each refusal once, under its reason.
- Unparsable request targets are `400` instead of `500`; refused bodies close the connection.
- `MAX_LIVE_TOTAL` holds under concurrent handshakes.
- IPv6 literals in `UPSTREAM_URL` / `UPSTREAM_LIVE_URL`.
- CI checks the routes against the plugin's `openapi.yaml`; the contract test fails when `MCD_OPENAPI` points nowhere.
- The live feed handshake now passes the app's `User-Agent` to the plugin, which refuses live connections without it.

### Changed
- `src/tunnel.ts` and `src/proxy.ts` split into smaller modules (see [docs/architecture.md](docs/architecture.md#modules)); licence headers; README logo and licence and terms section.

### Added
- Reverse tunnel (`TUNNEL_TOKEN`, `TUNNEL_ALLOWED_IPS`): the plugin dials in over one WebSocket that carries REST requests, live-feed streams and device events, so the proxy never connects to the server. Health checks (pings, dead-peer drop, hello timeout), `/tunnelz` on the admin port and `mcdp_tunnel_*` metrics. See [docs/tunnel.md](docs/tunnel.md).
- Device revocation feed: follows the plugin's `GET /v1/events` stream (`EVENTS_TOKEN`) and/or receives its signed webhooks (`WEBHOOK_*`). Revoked devices are refused at once on every node; the per-player cache is dropped whenever a revocation might have been missed.

## [0.1.0]

### Added
- Reverse proxy for the MCDashboard REST API (`/v1`) with a strict route allowlist derived from the OpenAPI contract.
- Shared response cache in Redis (memory fallback) honouring `Cache-Control`, `ETag` and `Vary`: public answers shared, per-player (`private`) answers cached per caller, request coalescing, revalidation, stale-if-error, negative caching.
- Per-client rate limits (read, pairing, write, bad tokens), concurrency caps per client and towards the plugin, load shedding.
- Optional edge verification of access tokens (HS256 only).
- WebSocket tunnel for `/v1/live` with connection limits and idle timeouts.
- Admin port with `/healthz`, `/readyz` and Prometheus `/metrics`.
- Docker image and compose file.
