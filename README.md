<p align="center"><img src="docs/assets/logo.svg" alt="MCDashboard" width="420"></p>

# MCDashboard-proxy

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

A caching, rate-limiting reverse proxy that sits between the apps and a Minecraft server running the
[MCDashboard](https://mcdashboard.org) plugin. The Minecraft server stays private; the proxy absorbs
the traffic, so a popular server or a hostile client cannot slow the game down.

```
 apps / browsers ──► TLS terminator ──► MCDashboard-proxy ──► Minecraft server (MCDashboard plugin)
                                              │
                                            Redis
                                 (shared cache + rate limits)
```

## Why

The plugin resolves PlaceholderAPI values on the server thread. Every app polling a placeholder is work
the game has to do. The proxy:

- **Caches** answers in Redis, per player for player-specific placeholders (never shared between players), for exactly the `max-age` the plugin announces, so a
  placeholder is resolved once per interval however many clients ask. Concurrent misses are coalesced into
  one request (never across a different player, typed player name, `User-Agent` or client attestation), stale
  entries are revalidated with `If-None-Match`, and a stale copy is served while the server restarts.
- **Protects** the server: only the routes of the API contract are forwarded, queries and bodies are
  validated and bounded, clients are rate limited (pairing and uploads far stricter than reads), the
  number of simultaneous requests towards the plugin is capped, shedding load with `503` instead of queueing,
  and one client can add only a bounded number of new cache entries.
- **Speaks the same HTTP as the plugin**: CORS headers on every answer and `OPTIONS` preflights answered
  locally, so browser clients work through the proxy exactly as they do against the plugin.
- **Follows revocations**: a device revoked in game is refused at once, even for cached answers, through the plugin's event stream or a signed webhook.
- **Filters tokens** (optional): forged, expired or invalid tokens are rejected before they reach the plugin,
  and clients that keep sending them are throttled.
- **Hides the server**: the Minecraft host's address, headers and error details never reach clients, and
  the plugin only ever sees the proxy.
- **Scales out**: run several proxies on one Redis; cache and rate-limit counters are shared.

It follows the same API guidelines as the plugin and transforms nothing, so the proxy never needs to know
placeholder names or evaluate templates.

## Quick start

The proxy is published as a public container image (`docker pull ghcr.io/mvdwsoftware/mcdashboard-proxy` needs no
account and nothing has to be built):

```sh
git clone https://github.com/MVdWSoftware/mcdashboard-proxy.git
cd mcdashboard-proxy
cp .env.example .env        # set REDIS_PASSWORD, TRUSTED_PROXIES
docker compose up -d        # pulls the image and a Redis
```

Or run the image directly, without the compose file (without `REDIS_URL` the cache lives in memory, which is
fine for one proxy):

```sh
docker run -d --name mcdashboard-proxy --restart unless-stopped \
  --env-file proxy.env --publish 8080:8080 \
  ghcr.io/mvdwsoftware/mcdashboard-proxy:latest
```

`latest` follows the main branch; production deployments pin a release tag or the digest it resolves to (every build
also has an immutable `sha-<commit>` tag). The image is built for `linux/amd64` and `linux/arm64`, runs as the
unprivileged `node` user and has its health check built in; tags, verification and upgrading are in
[docs/deployment.md](docs/deployment.md#container-image).

Then, in the plugin's `config.yml`, set `server.host: "<private address>"` so only the proxy can reach it, and
add the proxy to `security.trusted-proxies` so the plugin's own limits see real client addresses. Put TLS
in front of port `8080`; see [docs/deployment.md](docs/deployment.md).

Without Docker (Node 22+):

```sh
pnpm install && pnpm build
UPSTREAM_URL=http://127.0.0.1:1553 REDIS_URL=redis://127.0.0.1:6379 node dist/index.js
```

Without `REDIS_URL` the proxy keeps cache and counters in memory: fine for one node, but they are not shared.

To build the image from source instead of pulling it:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## What is and is not protected

The proxy defends the **application layer**: request floods that would make the plugin work, slow
clients, oversized or malformed requests, token brute force, cache-busting, and a flapping server.
It cannot stop volumetric network floods; those have to be absorbed before the traffic arrives (your
hosting provider's network protection or a CDN). See [docs/security.md](docs/security.md) for the
threat model.

## Documentation

| Topic | |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | every setting, with defaults |
| [docs/architecture.md](docs/architecture.md) | request flow, cache rules, failure behaviour |
| [docs/tunnel.md](docs/tunnel.md) | the reverse tunnel: the plugin dials in over one WebSocket (key, address allowlist, protocol) |
| [docs/deployment.md](docs/deployment.md) | Docker, nginx/Caddy in front, sizing, monitoring |
| [docs/security.md](docs/security.md) | threat model and hardening checklist |
| [CONTRIBUTING.md](CONTRIBUTING.md) | development, tests (`pnpm test:coverage`, 100% of `src/`) and pull requests |
| [SECURITY.md](SECURITY.md) | reporting vulnerabilities |
| [CHANGELOG.md](CHANGELOG.md) | releases |

## Compatibility

Tracks the MCDashboard API `v1`. Routes are checked against `openapi.yaml` of the plugin
repository in CI (`test/contract.test.ts`), so a new endpoint cannot be silently unreachable.

## Licence and terms

The proxy is free software under the [GNU AGPL v3 licence](LICENSE) © MVdW-Software. It is not a service MVdW-Software runs:
whoever deploys it operates it and is responsible for running it and for the data it caches.

Use of the MCDashboard app and the licence service is governed by the
[terms of service](https://mcdashboard.org/en/terms-of-service/) and the
[privacy statement](https://mcdashboard.org/en/privacy-statement/). The MCDashboard plugin and apps have their own licences.
