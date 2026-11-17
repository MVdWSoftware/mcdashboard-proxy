# Reverse tunnel

Instead of reaching the plugin, the proxy can let the plugin reach **it**. The plugin dials out to the proxy over **one
WebSocket**, and everything travels over that connection:

- REST requests (proxy to plugin), answered by the plugin's own API,
- live-feed byte streams (both ways), so the app's `/v1/live` socket is relayed without the proxy parsing frames,
- device revocations (plugin to proxy), so no stream or webhook is needed.

The proxy never opens a connection to the Minecraft server, so the server needs no inbound port for the API. It only has
to answer `GET /v1/info` for discovery (plugin `server.discovery-only`, `server.endpoints`).

## Turn it on

| Variable | Default | Meaning |
| --- | --- | --- |
| `TUNNEL_TOKEN` | unset | The API key. 32+ characters; setting it turns the tunnel on and makes `UPSTREAM_URL`, `UPSTREAM_LIVE_URL`, `EVENTS_TOKEN` and `WEBHOOK_*` irrelevant |
| `TUNNEL_ALLOWED_IPS` | empty | Comma separated addresses/CIDRs that may open the tunnel. Strongly recommended: the game server's address |
| `TUNNEL_PATH` | `/tunnel` | Where the plugin connects; cannot be under `/v1` |
| `TUNNEL_DEAD_S` | `60` | Seconds of silence after which the tunnel is dropped as dead (pings go out every third of it) |

Plugin (`config.yml`):

```yaml
tunnel:
  enabled: true
  url: "wss://proxy.example.com/tunnel"
  key: "<the same 32+ character key>"
server:
  discovery-only: true
  endpoints: ["https://proxy.example.com"]
```

Generate a key with `openssl rand -base64 36`.

## Health checks and reconnection

Both ends watch the connection, because a half-open socket (the server host crashed, a NAT dropped the mapping) looks alive
for hours and every request would just time out.

| | Proxy | Plugin |
| --- | --- | --- |
| Ping | every `TUNNEL_DEAD_S / 3` (20 s) | every 20 s |
| Dead peer | no byte for `TUNNEL_DEAD_S` (60 s): the connection is dropped, requests get `502` until the plugin is back | no byte for 60 s: the connection is dropped and re-dialled |
| Hello | a socket that does not say `hello` within 10 s is closed and never receives requests | no `ready` within 10 s: gives up and re-dials |
| Reconnect | not applicable, the plugin dials | exponential backoff 1 s to 60 s with jitter, forever |

The plugin's backoff only resets after a connection has stayed up for 30 s, so a proxy that accepts and immediately closes, or
two servers using the same key (a new connection replaces the old one), cannot cause a reconnect storm. Each connection
attempt is independent: a late close or error of an abandoned socket is ignored, so there is never more than one connection. An
outage is logged once and then every 10th attempt; the recovery is logged with the number of attempts it took.

What you can watch:

- Proxy admin port: `GET /tunnelz` (200 while connected, 503 otherwise, JSON with server, version, uptime, ping round trip, in-flight
  requests, live streams) and `/readyz` (not ready while the tunnel is down).
- Metrics: `mcdp_tunnel_connected`, `mcdp_tunnel_uptime_seconds`, `mcdp_tunnel_silent_seconds`, `mcdp_tunnel_rtt_ms`,
  `mcdp_tunnel_inflight`, `mcdp_tunnel_channels`, and counters `mcdp_tunnel_connects_total`, `mcdp_tunnel_dead_total`,
  `mcdp_tunnel_rejected_total{reason}`. Alert on `mcdp_tunnel_connected == 0` for a few minutes.
- Plugin: `/mcdashboard tunnel` (admin) shows connected or down, the last error, the attempt number, ping and live streams.

When the tunnel is down, answers that are still in the cache are served (within `STALE_IF_ERROR_S`); everything else is `502`
and live handshakes get `503`. Restart the proxy and the plugin reconnects by itself, within a few seconds.

## Security

The tunnel carries the plugin's whole API, so opening it is the most sensitive thing the proxy does.

1. **Address allowlist.** A peer that is not in `TUNNEL_ALLOWED_IPS` gets a plain `404`, so the endpoint is not even revealed.
   Behind a TLS terminator, the address is resolved with `TRUSTED_PROXIES` like for any client.
2. **API key.** `Authorization: Bearer <key>` on the upgrade request (never in the URL, so it is not logged by proxies).
   Compared in constant time. A wrong key is `401`.
3. **Rate limit.** Attempts are limited per client (the `RATE_AUTH` budget), so the key cannot be guessed.
4. **TLS.** The key is a bearer secret: terminate TLS in front of the proxy and use `wss://`. The plugin refuses `ws://` to a
   public host.
5. **One connection.** A new authenticated connection replaces the old one (a restarted plugin reconnects at once).
6. **Bounded.** Messages are limited to 4 MiB, responses to 2 MiB, live streams to `MAX_LIVE_TOTAL`, requests in flight
   to `MAX_UPSTREAM_CONCURRENCY`. Binary frames and unknown message types are refused or ignored; response headers are
   filtered exactly like for a direct upstream.
7. **Least reach.** The plugin only answers `/v1/*` over the tunnel (never `/v1/events`) and only connects to its own live
   port. The proxy still allows only the routes in the API contract.

Rotating the key: set the new key on the proxy and in the plugin, restart both. The old key stops working at once.

## Protocol (version 1)

A WebSocket (RFC 6455), text frames only, one JSON object per frame, `t` names the message. Bodies are base64.

| `t` | From | Fields | Meaning |
| --- | --- | --- | --- |
| `hello` | plugin | `server`, `version` | First message after connecting |
| `ready` | proxy | `since` (last event id or `null`) | The plugin may start sending events; it replays what was missed after `since` |
| `req` | proxy | `id`, `m`, `p`, `h`, `b?` | REST request: method, path with query, forwarded headers, body |
| `res` | plugin | `id`, `s`, `h`, `b` | Its answer: status, headers, body |
| `open` | proxy | `c` | Opens a live-feed stream (the plugin connects to its own live port) |
| `d` | both | `c`, `b` | Bytes of stream `c`, in order, including the WebSocket handshake |
| `x` | both | `c` | Closes stream `c` |
| `ev` | plugin | `id`, `e` | A device event ([plugin `docs/events.md`](https://github.com/MVdWSoftware/MCDashboard-plugin/blob/main/docs/events.md)), `id` is `epoch:seq` |
| `reset` | plugin | | Continuity with `since` is lost: the proxy drops per-player cache entries |

When the tunnel is down, see [health checks](#health-checks-and-reconnection).
