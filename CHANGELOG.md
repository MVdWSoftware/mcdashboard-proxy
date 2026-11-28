# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Push notifications (plugin 1.1.0, licensed servers): the proxy routes a device's own `GET`, `PUT` and `DELETE /v1/devices/self/push`
  (never cached) and reports the `push` feature, so apps behind the proxy can switch push on. CORS allows `PUT`.
- A public container image, `ghcr.io/mvdwsoftware/mcdashboard-proxy`, built and smoke-tested by GitHub Actions on every
  push to `main` and on every `vX.Y.Z` tag (`linux/amd64` and `linux/arm64`, provenance and SBOM attached, anonymous
  pulls). Tags: `latest`/`edge`/`main` for the branch, `X.Y.Z`/`X.Y` for releases, `sha-<commit>` for one build. See
  [docs/deployment.md](docs/deployment.md#container-image).
- Versioned tunnel handshake: `hello` carries the plugin's tunnel protocol, `ready` carries this proxy's protocol and the
  API features it carries end to end (`TUNNEL_PROTOCOL`, `TUNNEL_FEATURES`), and `/tunnelz` shows the plugin's protocol.
  The plugin publishes only the intersection in `/v1/info`, so an older proxy hides features it would drop. A proxy that
  forwards over plain HTTP sends the same list in `X-MCDashboard-Proxy-Features`. See
  [docs/tunnel.md](docs/tunnel.md#protocol-and-capabilities).

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
- `/v1/history/{id}` accepts the contract's `points` parameter (2–2000) instead of answering `400`; the app reduces long
  series with it.
- The `X-MCDashboard-Attestation`, `X-MCDashboard-Purpose` and `X-MCDashboard-Entitlement` headers reach the plugin (with
  the player header), so client verification, background limits and player names work through the proxy.
- Dead defensive branches removed (unreachable `??` fallbacks, an impossible length check in the WebSocket reader, a stale-connection guard in the tunnel) so the coverage numbers are real.
- `mcdp_rejected_total` counts each refusal once, under its reason.
- Unparsable request targets are `400` instead of `500`; refused bodies close the connection.
- `MAX_LIVE_TOTAL` holds under concurrent handshakes.
- IPv6 literals in `UPSTREAM_URL` / `UPSTREAM_LIVE_URL`.
- CI checks the routes against the plugin's `openapi.yaml`; the contract test fails when `MCD_OPENAPI` points nowhere.
- The live feed handshake now passes the app's `User-Agent` to the plugin, which refuses live connections without it.

### Changed
- `src/tunnel.ts` and `src/proxy.ts` split into smaller modules (see [docs/architecture.md](docs/architecture.md#modules)); licence headers; README logo and licence and terms section.

### Added
- `pnpm test:coverage` (`@vitest/coverage-v8`): 100% line, branch, function and statement coverage of `src/` (except the process entrypoint `src/index.ts`) is enforced; CI publishes the report.
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
