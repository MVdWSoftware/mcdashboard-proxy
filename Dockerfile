# Copyright (c) 2026 MVdW-Software
# SPDX-License-Identifier: AGPL-3.0-or-later

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080 9090
# With the admin port on, /healthz proves the event loop answers. ADMIN_PORT=0 disables it on purpose, so then only
# check that the public listener accepts a connection; a hardcoded 9090 would leave the container permanently unhealthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["sh", "-c", "p=\"${ADMIN_PORT:-9090}\"; if [ \"$p\" != 0 ]; then wget -qO- \"http://127.0.0.1:$p/healthz\" >/dev/null; else node -e 'require(\"node:net\").connect(Number(process.env.LISTEN_PORT || 8080), \"127.0.0.1\").on(\"connect\", function () { this.end(); process.exit(0); }).on(\"error\", function () { process.exit(1); });'; fi"]
CMD ["node", "dist/index.js"]
