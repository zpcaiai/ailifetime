FROM node:26-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ltm/web run build \
    && pnpm --filter @ltm/api... run build

FROM node:26-bookworm-slim AS runtime

ENV APP_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV LTM_DATABASE_PATH=.data/ltm.sqlite
WORKDIR /workspace

COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/packages/core ./packages/core
COPY --from=build --chown=node:node /workspace/packages/capabilities ./packages/capabilities
COPY --from=build --chown=node:node /workspace/services/api ./services/api
COPY --from=build --chown=node:node /workspace/apps/web/public ./apps/web/public
RUN mkdir -p /workspace/.data && chown node:node /workspace/.data

USER node
EXPOSE 8080

CMD ["node", "services/api/dist/main.js"]
