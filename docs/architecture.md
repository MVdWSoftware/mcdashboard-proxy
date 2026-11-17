# Architecture

## Modules

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point: configuration, store, listeners (public, admin, webhook), revocation feed, shutdown |
| `src/config.ts` | Environment variables, validated at startup |
| `src/proxy.ts` | Public HTTP server: request flow below, cache lookup and refresh, upgrade dispatch |
| `src/routes.ts` | Route allowlist of the API contract, canonical query and language |
| `src/scope.ts` | Cache scope of a caller (token check, revocation check, bad-token throttle) |
| `src/cache.ts` | What may be stored and for how long, cache entries in the store |
| `src/respond.ts` | Error and pass-through responses, bounded body reading |
| `src/clientip.ts` | Client address behind trusted proxies, address lists, rate-limit buckets |
| `src/ratelimit.ts`, `src/store.ts` | Fixed-window counters and concurrency gates; Redis, memory and fallback store |
| `src/jwt.ts`, `src/revocations.ts`, `src/events.ts`, `src/webhook.ts` | Edge token check, deny list and cache generation, SSE client and webhook receiver |
| `src/upstream.ts` | HTTP pool towards the plugin |
| `src/live.ts` | Live-feed relay |
| `src/websocket.ts` | RFC 6455 handshake, refusals and the text-frame connection used by the tunnel |
| `src/tunnel-upgrade.ts`, `src/tunnel.ts`, `src/tunnel-channel.ts` | Tunnel admission (address, rate limit, key), the hub that multiplexes requests and events, live channels over the tunnel |

## Request flow

1. **Client address.** The peer address, or `X-Forwarded-For` when the peer is in `TRUSTED_PROXIES`.
   A per-client cap on simultaneous requests applies first.
2. **Route allowlist** (`src/routes.ts`). Method, path and every query parameter are checked against the
   API contract: ids must look like ids (`[A-Za-z0-9_.-]{1,64}`), `ids` lists have at most 100 entries, unknown
   or repeated parameters are `400`. Unknown paths are `404` and wrong methods `405`; none of them reach the plugin.
3. **Rate limit** per client and class (read, auth, write) in the shared store.
4. **Token check** when `MCD_JWT_SECRET` is set (signature, type and expiry).
5. **Body**: only for the three routes that take one; `Content-Length` required, size limited, JSON only.
6. **Cache** (`GET`/`HEAD`, scoped per caller), then **plugin** with the concurrency cap.

Only a fixed set of request headers (`Accept`, `Accept-Language`, `Authorization`, `Content-Type`,
`If-None-Match`, `User-Agent`) is passed on, and only a fixed set of response headers comes back
(`Content-Type`, `Cache-Control`, `ETag`, `Vary`, `Content-Language`, `WWW-Authenticate`, `Retry-After`).

## Cache rules

The plugin already describes what is shareable (see its `docs/reverse-proxy.md`); the proxy follows it:

- A response is stored only if the plugin answered `200` with `Cache-Control: max-age=N` (`N > 0`) and it is
  `public` (anonymous requests) or `private` (requests with a token). `no-store` is never stored, nor is an answer whose
  `Vary` names a header the key does not cover (anything but `Authorization` and `Accept-Language`).
- **Scope.** Anonymous requests share one scope. A request with a token gets its own: with `MCD_JWT_SECRET`
  the verified player (`p:<player uuid>`, so all of a player's devices share entries), without it a hash of the
  token (`t:<hash>`). The scope is part of the key, so a per-player answer such as `player-name` is cached per
  player and can never be served to another player or to an anonymous client. Towards clients the answer
  stays `Cache-Control: private`.
- Entries stay fresh for `N` seconds (the placeholder's `min-interval`) and are served with an `Age` header
  and `Cache-Status: mcdashboard-proxy; hit` (RFC 9211).
- **Key** = path + sorted query + the languages of `Accept-Language` that the server supports, in order.
  `?ids=b,a` and `?ids=a,b` are one entry; arbitrary header values cannot create new entries. On a miss the plugin
  is asked with exactly those languages (no header when none is supported), so it cannot answer in a language the key
  does not tell apart.
- **Revalidation.** A stale entry is refreshed with `If-None-Match`; a `304` renews it without transferring a body.
  Clients that send `If-None-Match` get `304` from the proxy directly.
- **Coalescing.** Simultaneous misses for the same key share one upstream request.
- **Stale-if-error.** If the plugin times out, errors or restarts, a copy up to `STALE_IF_ERROR_S`
  past expiry is served; otherwise the client gets `502`.
- **Negative caching.** Errors the plugin sends without cache headers are remembered for `NEGATIVE_TTL_S`, so a flood
  of requests for unknown ids is answered by the proxy: `404` in every scope, `401` only where it cannot belong to another
  device's token (anonymous or per-token scope). `403` is never remembered: the plugin answers it for a `User-Agent` it does
  not accept, so one client could otherwise make every app see it. The current plugin sends `Cache-Control: no-store` on
  errors, which turns negative caching off.

Limits of per-player caching:

- **Revocation.** A cached answer is served without asking the plugin, so without a revocation feed a device revoked in
  game can still read what is already cached for its player until that entry expires (at most the placeholder's
  `min-interval`, seconds). See [Revocation feed](#revocation-feed) to close that gap. Tokens that were never verified
  are not given long-lived entries for the same reason.
- **Unverified tokens.** Without `MCD_JWT_SECRET` the proxy cannot tell whether a token is genuine; it only
  stores `private` answers the plugin returned for that exact token. A `public` answer means the plugin did not
  recognise the token, so it is not stored (random tokens cannot fill the cache), and errors are not remembered. Set
  the secret to key by player and to reject forged tokens before they cost anything.
- **Client policy.** The plugin refuses unknown apps by `User-Agent` (`403`, or `426` for an app that is too old). The
  proxy forwards the header, but a cached answer is served whatever the `User-Agent`; the plugin itself treats it as an
  identification, not a credential.
- Entries are short-lived and bounded by Redis `maxmemory` (`volatile-ttl`, which evicts them before revocation state), so many players cannot grow the cache unboundedly.

## Revocation feed

The plugin announces revoked devices ([plugin `docs/events.md`](https://github.com/MVdWSoftware/MCDashboard-plugin/blob/main/docs/events.md)),
either as a stream the proxy follows (`EVENTS_TOKEN`) or as signed webhooks the proxy receives (`WEBHOOK_*`). Both feed the same
two structures in the shared store, so every proxy node acts at once:

- **Deny list** of device ids (`REVOCATION_TTL_S`). A request whose token names a denied device is answered
  `401 {"error":"device revoked"}` before any cache is consulted. This is per device on purpose: a player's other devices share
  the player's cache entries and keep working. It needs no secret (the `sub` of an unverified token can only get a request refused).
- **Generation**, part of every per-player cache key. Bumping it drops all per-player entries on all nodes, and is the answer
  whenever a missed revocation is possible: the first connect of the stream, a `reset` from the plugin (it restarted or the
  history moved on), or a start with webhooks only (webhooks cannot resume). The cost is a few extra upstream requests.

The stream reconnects with backoff and resumes from `Last-Event-ID`, so a short outage loses nothing. A webhook that the plugin
gave up on (after about 12 minutes of failures) cannot be detected: run the stream, or both. Without any feed the proxy
logs a warning at startup. Open live-feed tunnels are not affected by revocations.

## Failure behaviour

| Failure | Result |
| --- | --- |
| Redis down | Falls back to a per-process memory store for 5 s at a time; API stays up (limits, cache and deny list become per node, so a device revoked before the outage is only caught by the plugin on a miss). `mcdp_redis_up` goes to 0 |
| Plugin down / slow | Stale copies are served; otherwise `502` with `Retry-After: 5` |
| Event stream down | Reconnects with backoff; on resume the plugin replays what was missed, or sends `reset` and the per-player cache is dropped |
| Plugin saturated | `503` with `Retry-After: 1` once `MAX_UPSTREAM_CONCURRENCY` requests are in flight |

## Reaching the plugin

By default the proxy connects to the plugin (HTTP for REST, a byte relay for the live feed, a stream or webhooks for revocations).
With `TUNNEL_TOKEN` the plugin connects to the proxy instead and all three travel over [one WebSocket](tunnel.md); the rest of the
request flow is unchanged.

## Live feed

The live feed upgrades to a WebSocket and is relayed byte for byte to the plugin's live port. The proxy
does not read frames (authentication happens in the first message, as in the plugin). It limits connections
per client and in total, rate limits handshakes, and closes connections idle for 5 minutes. Refused upgrades are
answered with a status line and the socket is closed at once.
