# Contributing

Thanks for helping! Bug reports, fixes, documentation and ideas are all welcome.

## Ground rules

- **The contract comes first.** The proxy speaks the same API as the plugin
  (`openapi.yaml` in the [MCDashboard-plugin repository](https://github.com/MVdWSoftware/MCDashboard-plugin)).
  It must not invent endpoints or change responses. If the API changes, `src/routes.ts` changes with it
  and `test/contract.test.ts` proves every operation is still routed (set `MCD_OPENAPI` to the contract file).
- **Never share per-player data.** `private` answers are cached only under the caller's own scope. Any change
  near the cache needs a test that shows they are not served to another player or to anonymous clients.
- **Revocation first.** Anything that serves a per-player answer must check the deny list first and include the generation in the key.
- **Few dependencies.** Node's standard library does the work; `ioredis` is the only runtime dependency.
  Adding one needs a good reason in the pull request.
- **Fail safe.** A Redis outage must degrade to local caching, never take the API down.
- Keep the docs current in the same change (README, `docs/`, changelog).

## Development

```sh
corepack enable
pnpm install
pnpm lint      # type check
pnpm test      # unit and integration tests, no Redis needed
REDIS_URL=redis://localhost:6379 pnpm test   # also runs the Redis tests
pnpm build
```

A fake plugin (`test/helpers.ts`) emits the same cache headers as the real one, so the suite needs no
Minecraft server.

## Pull requests

1. Open an issue first for larger changes.
2. Add or update tests; `pnpm lint && pnpm test` must pass.
3. Describe the behaviour change and add an entry under *Unreleased* in the changelog.
4. By contributing you agree your work is released under the [GNU AGPL v3 licence](LICENSE).
