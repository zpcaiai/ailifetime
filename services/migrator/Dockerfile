FROM node:26.0.0-bookworm-slim@sha256:3529ef69feecddd94e9c5ecd3d25a96f2f23ea40661f494f932ae2b12ab1977c AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN npm install --global --ignore-scripts pnpm@10.12.4 \
    && test "$(pnpm --version)" = "10.12.4"
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @ltm/migrator deploy --prod --legacy /runtime/migrator

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:9b945e92c1b5463a4b75f11e8417515e4bea7355f6adfd79ec220fbbe905dda8 AS runtime

ENV APP_ENV=production
WORKDIR /workspace

COPY --from=build --chown=10001:10001 /runtime/migrator ./services/migrator
COPY --from=build --chown=10001:10001 /workspace/infra/postgres/migrations ./infra/postgres/migrations

USER 10001:10001
ENTRYPOINT ["/nodejs/bin/node", "services/migrator/src/main.mjs"]
CMD ["--profile=production", "--manifest=/workspace/infra/postgres/migrations/manifest.json"]
