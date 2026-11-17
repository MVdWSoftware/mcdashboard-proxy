# AGENTS.md

- **Same API as the plugin.** Routes mirror `openapi.yaml` of MCDashboard-plugin; change
  `src/routes.ts` and the contract test together. Errors are `{"error": "..."}`.
- **Cache scope is part of the key.** Anonymous requests store `public` answers; requests with a token store
  `private` answers under their own scope (player claim, or token hash without the secret). Never serve an
  entry across scopes, and keep `Cache-Control: private` towards clients.
- **Tokens are JWT HS256**; reject any other `alg`. The proxy only checks signature and expiry, revocation
  is the plugin's job.
- **Revocations** come from the plugin (`docs/events.md` in MCDashboard-plugin): deny list per device id plus a cache generation in the shared store. The signature scheme has a test vector asserted on both sides.
- **Tunnel** (`src/tunnel.ts`, `docs/tunnel.md`): key + optional address allowlist + attempt rate limit before the upgrade; never log the key; keep it dependency-free (the proxy is open source, do not depend on `@mvdw/*`).
- Runtime dependency: `ioredis` only. Redis failures fall back to memory (`FallbackStore`).
- Commands: `pnpm lint && pnpm test && pnpm build`.
- Docs: module docs live in `docs/`; keep them current in the same change.
