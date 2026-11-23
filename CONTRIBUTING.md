# Contributing

Thanks for helping! Bug reports, fixes, documentation and ideas are all welcome.

## Ground rules

- **The contract comes first.** The proxy speaks the same API as the plugin
  (`openapi.yaml` in the [MCDashboard-plugin repository](https://github.com/MVdWSoftware/mcdashboard-plugin)).
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
pnpm test:coverage   # same, plus coverage; fails below 100% lines, branches, functions and statements of src/ (report in coverage/)
REDIS_URL=redis://localhost:6379 pnpm test   # also runs the Redis tests
pnpm build
```

A fake plugin (`test/helpers.ts`) emits the same cache headers as the real one, so the suite needs no
Minecraft server.

## Container image

Pull requests build the image and start it (`smoke` in `.github/workflows/image.yml`): `/healthz` must answer, the
public listener must answer `OPTIONS` with the CORS headers the app needs, the process must not run as root and the
built-in `HEALTHCHECK` must turn healthy. A broken `Dockerfile` therefore never merges.

```sh
docker build -t mcdashboard-proxy .                                # what CI builds
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build   # with Redis, from this checkout
```

The `Image` workflow publishes on its own, after the same smoke test:

- a push to `main` publishes `edge`, `latest`, `main` and `sha-<commit>`;
- a `vX.Y.Z` tag publishes `X.Y.Z`, `X.Y` and `latest` (bump `version` in `package.json`, update `CHANGELOG.md`, then
  tag and push the tag).

It pushes to `ghcr.io/mvdwsoftware/mcdashboard-proxy` with the workflow's `GITHUB_TOKEN`; no secret has to be
configured. Provenance and an SBOM are attached. When releasing, check the run and that the package's visibility is
still *Public* (Package settings → Danger Zone).

## Pull requests

1. Open an issue first for larger changes.
2. Add or update tests; `pnpm lint && pnpm test:coverage && pnpm build` must pass; `src/` stays at 100% coverage (only `src/index.ts`, the process entrypoint, is excluded).
3. Describe the behaviour change and add an entry under *Unreleased* in the changelog.
4. By contributing you agree your work is released under the [GNU AGPL v3 licence](LICENSE).
