# Configuration

All settings are environment variables. Invalid values stop the proxy at startup with a message.

## Connections

| Variable | Default | Meaning |
| --- | --- | --- |
| `UPSTREAM_URL` | `http://127.0.0.1:1553` | The plugin's REST port (`server.port`). Plain HTTP: set `server.tls.mode: off` and `server.host: 127.0.0.1` in the plugin, because the plugin serves HTTPS by default. Not used with the [tunnel](tunnel.md) |
| `UPSTREAM_LIVE_URL` | `http://127.0.0.1:1554` | The plugin's WebSocket port (`server.websocket.port`). Not used with the tunnel |
| `TUNNEL_TOKEN` | unset | API key (32+ chars) of the [reverse tunnel](tunnel.md): the plugin dials in over one WebSocket |
| `TUNNEL_ALLOWED_IPS` | empty | Addresses/CIDRs allowed to open the tunnel (recommended) |
| `TUNNEL_PATH` | `/tunnel` | Where the plugin connects |
| `TUNNEL_DEAD_S` | `60` | Silence after which the tunnel is dropped as dead; see [health checks](tunnel.md#health-checks-and-reconnection) |
| `LISTEN_HOST` / `LISTEN_PORT` | `0.0.0.0` / `8080` | Public listener (put TLS in front) |
| `ADMIN_HOST` / `ADMIN_PORT` | `127.0.0.1` / `9090` | `/healthz`, `/readyz`, `/tunnelz`, `/metrics`; `ADMIN_PORT=0` disables it. Never expose it publicly; in a container set `ADMIN_HOST=0.0.0.0` only when something on the container network scrapes it |
| `REDIS_URL` | unset | e.g. `redis://:password@redis:6379`. Unset = in-memory (single node) |
| `REDIS_KEY_PREFIX` | `mcdp:` | Lets several proxies share one Redis without clashing |

## Client identity

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRUSTED_PROXIES` | empty | Comma separated addresses/CIDRs (`10.0.0.0/8,::1`) of your TLS terminator or CDN. Only these may set `X-Forwarded-For`; the right-most address that is not trusted is the client. Leave empty when clients connect directly |

The proxy always sends `X-Forwarded-For: <client>` to the plugin (overwriting any client value), so add the
proxy's address to the plugin's `security.trusted-proxies`. IPv6 clients are limited per `/64`.

## Rate limits (per client, per window)

| Variable | Default | Applies to |
| --- | --- | --- |
| `RATE_WINDOW_S` | `60` | Window length |
| `RATE_READ` | `300` | `GET` routes and live handshakes |
| `RATE_AUTH` | `10` | Pairing and token refresh (same as the plugin) |
| `RATE_WRITE` | `6` | Dashboard upload and device unpairing |
| `RATE_BAD_TOKEN` | `20` | invalid tokens before the client is answered with `429` |
| `MAX_CONCURRENT_PER_IP` | `20` | simultaneous requests per client |
| `MAX_LIVE_PER_IP` / `MAX_LIVE_TOTAL` | `5` / `500` | open live-feed connections |

Over the limit the answer is `429` with `Retry-After`.

## Protecting the plugin

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_UPSTREAM_CONCURRENCY` | `32` | Requests in flight towards the plugin; more are answered `503` + `Retry-After` |
| `UPSTREAM_TIMEOUT_MS` | `5000` | Give up on the plugin (`502`) |
| `MAX_BODY_BYTES` | `32768` | Request body limit (`413`); matches the plugin's own |
| `MAX_URL_LENGTH` | `4096` | `414` above this |

## Cache

| Variable | Default | Meaning |
| --- | --- | --- |
| `STALE_IF_ERROR_S` | `300` | How long past expiry a copy may be served while the plugin fails or is restarting |
| `NEGATIVE_TTL_S` | `5` | How long `404` (and `401` outside a player scope) answers without cache headers are remembered; `0` disables. See [negative caching](architecture.md#cache-rules) |
| `CACHE_MAX_BODY_BYTES` | `524288` | Larger answers are not cached |
| `LANGUAGES` | `en,nl,fr,de,es` | Languages the plugin supports; `Accept-Language` is reduced to these for the cache key |

## Token check (optional)

| Variable | Meaning |
| --- | --- |
| `MCD_JWT_SECRET` | The base64 text in the plugin's `plugins/MCDashboard/secret.key`. Treat it like a password: with it the proxy can verify tokens, and so could anyone who steals it forge them. Provide it through a secret store, not a committed file |

With the secret set, requests with an invalid or expired `Authorization` header are answered `401` at the
proxy, and per-player cache entries are keyed by the player, so a player's devices share them. Without it,
tokens are passed through unchecked and entries are keyed per token. Revoked devices are refused through the
[revocation feed](#device-revocations), and by the plugin on every cache miss.

## Device revocations

Without these, a revoked device can still be served what is cached for its player until that entry expires (at most
one `min-interval`). With either, it is refused at once. Details and the plugin side: [plugin `docs/events.md`](https://git.mvdw-software.com/mcdashboard/mcdashboard-plugin/blob/main/docs/events.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVENTS_TOKEN` | unset | The plugin's `events.token`. The proxy follows the device event stream, reconnecting automatically |
| `WEBHOOK_SECRET` | unset | The `secret` of the plugin's `events.webhooks` entry (16+ characters) |
| `WEBHOOK_PORT` / `WEBHOOK_HOST` | `0` (off) / `127.0.0.1` | Listener for the webhook receiver. Reachable by the Minecraft server only |
| `WEBHOOK_TOLERANCE_S` | `300` | Largest accepted difference between the webhook timestamp and the proxy's clock |
| `REVOCATION_TTL_S` | `3600` | How long a revoked device id is remembered; at least the plugin's `security.access-token-timeout` |

## Metrics

`/metrics` (admin port, Prometheus text): `mcdp_cache_total{result,route}`, `mcdp_coalesced_total`,
`mcdp_stale_served_total`, `mcdp_upstream_total`, `mcdp_upstream_errors_total`, `mcdp_errors_total`,
`mcdp_rejected_total{reason}` (one count per refusal: `rate_limit`, `concurrency`, `bad_token`, `revoked`,
`upstream_saturated`, `live_connections`, or the status code), `mcdp_revocations_total`, `mcdp_events_connected`,
`mcdp_events_connects_total`, `mcdp_events_resets_total`, `mcdp_webhook_rejected_total{status}`, `mcdp_live_total`, `mcdp_redis_up`,
`mcdp_store_fallback_total`, and the `mcdp_tunnel_*` series of the [tunnel](tunnel.md#health-checks-and-reconnection).
