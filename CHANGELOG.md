# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- The live feed handshake now passes the app's `User-Agent` to the plugin, which refuses live connections without it.

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
