# Security

## Threat model

| Threat | Mitigation |
| --- | --- |
| Request floods making the plugin resolve placeholders | Shared cache with coalescing; per-client rate limits; cap on requests in flight towards the plugin with `503` shedding |
| Cache busting with random query strings or headers | Strict query allowlist and canonical cache key; `Accept-Language` reduced to supported languages |
| Probing for other endpoints | Anything outside the API contract is answered `404` locally |
| Pairing code and refresh brute force | `10`/minute per client at the edge (plus the plugin's own limit) |
| Forged or stolen-secret-less tokens, `alg: none` | Optional HS256-only check at the edge, failures throttled |
| Slowloris, huge headers, huge bodies | Header, request and idle timeouts, 8 KB header limit, URL and body limits |
| Spoofed `X-Forwarded-For` to evade limits | Only honoured from `TRUSTED_PROXIES`; right-most untrusted hop is used |
| One player's data served to another | The caller's identity (verified player, or token hash) is part of the cache key; `private` answers are stored only under it and never served to anyone else |
| Revoked device still reading | With a revocation feed (`EVENTS_TOKEN` or `WEBHOOK_*`) the device is refused at once, on every node. Without one, cached answers live at most one `min-interval`; the plugin decides on every miss |
| Forged or replayed webhook | HMAC-SHA256 over timestamp and body, constant-time compare, timestamp tolerance, separate private port, 8 KB limit |
| Plugin crash or restart | Stale-if-error, `502` with `Retry-After`, no retry storms |
| Information leaks | Upstream headers and error pages are not forwarded; the origin address stays private |
| Redis tampering or outage | Redis is internal (password, not published); outage falls back to local memory |

Not covered: volumetric (L3/L4) floods, compromise of the Minecraft host, and application bugs inside the plugin.

## Hardening checklist

- [ ] Plugin ports firewalled to the proxy; `server.host` not public.
- [ ] TLS terminator in front; its address in `TRUSTED_PROXIES` and nothing broader.
- [ ] `ADMIN_HOST` left on loopback (or firewalled); `/metrics` not published.
- [ ] Redis not reachable from the internet, with a password.
- [ ] `MCD_JWT_SECRET` (if used) from a secret store; remember the proxy host can then forge tokens, so
      run it only where you would also keep `secret.key`.
- [ ] Network-level DDoS protection from your host or a CDN.
- [ ] Revocation feed on (`EVENTS_TOKEN`, optionally `WEBHOOK_*`); the webhook port reachable by the Minecraft server only.
- [ ] Alert on `mcdp_rejected_total` and `mcdp_redis_up == 0`.
