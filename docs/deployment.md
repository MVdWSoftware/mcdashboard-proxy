# Deployment

## Topology

Keep the Minecraft host's MCDashboard ports reachable only by the proxy:

1. Plugin `config.yml`: `server.host: "<address reachable by the proxy only>"`, and the proxy's address in
   `security.trusted-proxies`.
2. Firewall `1553` and `1554` to the proxy's address.
3. Run the proxy (Docker below), then TLS in front of its port `8080`.

The proxy may run on the Minecraft machine, but the point of a separate host is that an attack saturates the proxy
rather than the game server.

## Container image

GitHub Actions builds and publishes the proxy from this repository on every push to `main` and on every `vX.Y.Z` tag
([`.github/workflows/image.yml`](../.github/workflows/image.yml)). Every build is started and checked (`/healthz`, CORS
preflight, non-root user, Docker health check) before it is pushed. The image is
`ghcr.io/mvdwsoftware/mcdashboard-proxy`.

The image is public, so pulling it needs no account or token:

```sh
docker pull ghcr.io/mvdwsoftware/mcdashboard-proxy:latest
```

It is published from the default branch (a `vX.Y.Z` tag publishes release tags too). Each build is started and
checked before it is pushed; see [CONTRIBUTING.md](../CONTRIBUTING.md#container-image) for the release flow.

| Tag | Published | Use |
| --- | --- | --- |
| `latest` | every push to `main`, and every release | try it out; it moves |
| `edge` / `main` | every push to `main` | the same build as `latest`, under a name that says what it is |
| `X.Y.Z` / `X.Y` | tag `vX.Y.Z` | production; `X.Y` follows the patch releases |
| `sha-<commit>` | every build | exactly one commit, for reproducing an issue |
| `@sha256:…` (digest) | every build | immutable; pin this when in doubt |

Both `linux/amd64` and `linux/arm64` are published, because Minecraft hosts are often ARM machines (Ampere,
Raspberry Pi). The image is `node:22-alpine` with production dependencies only, runs as the unprivileged `node`
user, exposes the public port `8080` and keeps the admin port `9090` on the container's loopback. Its `HEALTHCHECK`
asks `/healthz`; with `ADMIN_PORT=0` it falls back to a TCP check on the public port, so `docker compose up --wait`
works either way.

Run it with an environment file (every setting is a variable, see [configuration.md](configuration.md)):

```sh
cp .env.example proxy.env     # fill in REDIS_PASSWORD and TRUSTED_PROXIES; or leave REDIS_URL unset to use memory
docker run -d --name mcdashboard-proxy --restart unless-stopped \
  --env-file proxy.env --publish 8080:8080 \
  ghcr.io/mvdwsoftware/mcdashboard-proxy:latest
docker logs mcdashboard-proxy      # mcdashboard-proxy on 0.0.0.0:8080 -> http://…
```

The container needs no volume: the cache, rate-limit counters and revocations live in Redis, or in memory when
`REDIS_URL` is unset. Stopping and recreating it loses nothing.

Pin a release tag, or a digest when the deployment must never change under you:

```sh
docker pull ghcr.io/mvdwsoftware/mcdashboard-proxy:latest    # or a release tag such as :0.1.0
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/mvdwsoftware/mcdashboard-proxy:latest
```

Upgrading is pulling the new tag and recreating the container; the proxy is stateless.

Inspect what was published, including the manifest list for both architectures and the build provenance and SBOM
attestations:

```sh
docker buildx imagetools inspect ghcr.io/mvdwsoftware/mcdashboard-proxy:latest
```

Build the image from a checkout instead (that is what `docker compose up -d` and every pull request do):

```sh
docker build -t mcdashboard-proxy .
```

The image contains AGPL-3.0 code. Running an unmodified copy is fine; if you modify the proxy and let clients use it
over a network, the licence requires you to offer the modified source.

## Docker Compose

`docker-compose.yml` builds the proxy from this checkout and starts it next to a password-protected Redis (no published
port, 128 MB, no persistence). To run the published image instead, pull and tag it as above and start it with
`docker run`, or point the compose service's `image:` at it and remove `build: .`.
The eviction policy is `volatile-lru`: a full Redis drops the least recently used entry, which
is a cold cache entry, not a hot rate-limit counter. `volatile-ttl` would drop the entry closest to expiry, and that is
the 60-second counter rather than a cache entry (cache entries live `max-age` + `STALE_IF_ERROR_S`); resetting the
counters is exactly what a cache-fill wants, so the limits would fall away one by one. `allkeys-lru` would also evict
non-expiring keys and says nothing about policy, so it is not used either.

The trade-off to know about: LRU has no notion of importance, so under sustained pressure it can eventually evict a
revocation deny-list entry that no device has asked about for a long time. That list is tiny (one short value per
revoked device) and is the reason Redis needs enough `maxmemory` for the deny list plus the working set, not only for
the cache. Watch `mcdp_redis_up` and the evicted-keys metric of Redis itself.

Configure it through `.env` ([`.env.example`](../.env.example)) and see [configuration.md](configuration.md) for every
variable. Keep the admin port on the container's loopback; publish only `8080` and put TLS in front of it.

```sh
docker compose up -d
curl http://localhost:8080/
```

## TLS in front

Tokens should never travel in the clear, so use HTTPS. Any terminator works; it must pass `Upgrade` for the live feed and set
`X-Forwarded-For` to the real client (overwrite, do not append) with its own address in `TRUSTED_PROXIES`.
Do not enable a second cache there: the proxy already caches correctly.

Caddy:

```
mc.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name mc.example.com;
    # ssl_certificate ...
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;   # map $http_upgrade $connection_upgrade { default upgrade; '' close; }
        proxy_set_header X-Forwarded-For $remote_addr;
        # Keep the hostname the app called: the plugin verifies client attestations against it (nginx would
        # otherwise send its own proxy_pass address instead).
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
    }
}
```

Caddy preserves `Host` by default. The proxy forwards it (and `X-Forwarded-Host`) to the plugin. For
`security.client-verification`, prefer listing the public hostname in the plugin's `security.client-verification.hosts`:
the assertion's audience is then checked against that list, which also works through the reverse tunnel (where the plugin
sees its own loopback `Host`). With that list empty the plugin compares the audience to the `Host` header, so the
terminator and the proxy must pass it through (nginx: `proxy_set_header Host $host`, as above).

Set `TRUSTED_PROXIES=127.0.0.1` for either when the proxy runs directly on the host. With the compose file the proxy
sees the Docker bridge gateway instead (for example `172.17.0.1`; check with `docker network inspect`), so trust that
address. If the trusted address is wrong, `X-Forwarded-For` is ignored and every client shares one rate-limit budget.
Behind Cloudflare, use its published ranges and have the terminator forward `CF-Connecting-IP` as `X-Forwarded-For`.

## Sizing

The proxy is I/O bound; one small instance serves thousands of cached requests per second. Run two or more
behind the terminator for availability; they share Redis. The Redis memory needed is the number of distinct
(route, query, language) combinations times the typical answer size (a few KB).

## Revocation feed

In the plugin's `config.yml` set `events.token` (16+ random characters) and give the same value to the proxy as `EVENTS_TOKEN`.
The proxy then follows the stream and reconnects by itself. For a push instead (or as well), add an `events.webhooks` entry
pointing at `http(s)://<proxy>:<WEBHOOK_PORT>/hooks/mcdashboard` with a `secret`, and set `WEBHOOK_SECRET`, `WEBHOOK_PORT` and
`WEBHOOK_HOST` on the proxy. Keep the webhook port off the public side (firewall it to the Minecraft host) and use HTTPS when it
crosses a network you do not control. Check `mcdp_events_connected` (1 = stream up) and `mcdp_revocations_total`.

## Monitoring

Scrape `http://<proxy>:9090/metrics` with Prometheus and use `/readyz` for load balancer checks (it verifies that the
plugin answers; a Redis outage does not make it fail, because the proxy keeps serving from memory). In Docker, set
`ADMIN_HOST=0.0.0.0` for that and keep port 9090 off any published or public interface. Watch the cache hit ratio
(`mcdp_cache_total`), `mcdp_rejected_total{reason}` for attacks, `mcdp_upstream_errors_total` for plugin trouble and
`mcdp_redis_up` / `mcdp_store_fallback_total` for Redis.

## Upgrading

Releases follow semver and are listed in the [changelog](../CHANGELOG.md). The proxy is stateless;
restart it any time, the cache lives in Redis. With the image: pull the new tag and recreate the container. With the
compose file: `git pull && docker compose up -d --build`.
