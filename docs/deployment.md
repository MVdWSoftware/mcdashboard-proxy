# Deployment

## Topology

Keep the Minecraft host's MCDashboard ports reachable only by the proxy:

1. Plugin `config.yml`: `server.host: "<address reachable by the proxy only>"`, and the proxy's address in
   `security.trusted-proxies`.
2. Firewall `1553` and `1554` to the proxy's address.
3. Run the proxy (Docker below), then TLS in front of its port `8080`.

The proxy may run on the Minecraft machine, but the point of a separate host is that an attack saturates the proxy
rather than the game server.

## Docker Compose

`docker-compose.yml` starts the proxy and a password-protected Redis (no published port,
`allkeys-lru`, 128 MB, no persistence: the cache can always be rebuilt). Configure it through `.env`
([`.env.example`](../.env.example)) and see [configuration.md](configuration.md) for every variable.

```sh
docker compose up -d
curl http://localhost:8080/v1/info
```

## TLS in front

Tokens are bearer tokens, so use HTTPS. Any terminator works; it must pass `Upgrade` for `/v1/live` and set
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
        proxy_read_timeout 120s;
    }
}
```

Set `TRUSTED_PROXIES=127.0.0.1` for either. Behind Cloudflare, use its published ranges and have the
terminator forward `CF-Connecting-IP` as `X-Forwarded-For`.

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

Scrape `http://<proxy>:9090/metrics` with Prometheus and use `/readyz` for load balancer checks (it verifies
the plugin and Redis). Watch the cache hit ratio (`mcdp_cache_total`), `mcdp_rejected_total{reason}` for attacks and
`mcdp_upstream_errors_total` for plugin trouble.

## Upgrading

Releases follow semver and are listed in the [changelog](../CHANGELOG.md). The proxy is stateless;
restart it any time, the cache lives in Redis.
