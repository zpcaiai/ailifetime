FROM node:26.0.0-bookworm-slim@sha256:3529ef69feecddd94e9c5ecd3d25a96f2f23ea40661f494f932ae2b12ab1977c AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN npm install --global --ignore-scripts pnpm@10.12.4 \
    && test "$(pnpm --version)" = "10.12.4"
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ltm/workers... run build \
    && pnpm --filter @ltm/workers deploy --prod --legacy /runtime/workers
RUN find /runtime/workers -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf '{}' + \
    && find /runtime/workers -type f \( -name '*.test.js' -o -name '*.test.cjs' -o -name '*.test.mjs' -o -name '*.spec.js' -o -name '*.spec.cjs' -o -name '*.spec.mjs' -o -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' -o -name '*.tsbuildinfo' \) -delete \
    && find /runtime/workers/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \( -name '@types+*' -o -name 'typescript@*' -o -name 'tsx@*' \) -exec rm -rf '{}' + \
    && find /runtime/workers/node_modules -name '@types' -exec rm -rf '{}' + \
    && find /runtime/workers/node_modules -type l \( -name typescript -o -name tsx \) -delete \
    && node -e "const fs=require('node:fs');const file='/runtime/workers/package.json';const value=JSON.parse(fs.readFileSync(file,'utf8'));delete value.devDependencies;fs.writeFileSync(file,JSON.stringify(value));" \
    && test -f /runtime/workers/dist/main.js \
    && test -z "$(find /runtime/workers -type f \( -name '*.test.js' -o -name '*.test.cjs' -o -name '*.test.mjs' -o -name '*.spec.js' -o -name '*.spec.cjs' -o -name '*.spec.mjs' -o -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' -o -name '*.tsbuildinfo' \) -print -quit)" \
    && test -z "$(find /runtime/workers/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \( -name '@types+*' -o -name 'typescript@*' -o -name 'tsx@*' \) -print -quit)"

FROM node:26.0.0-bookworm-slim@sha256:3529ef69feecddd94e9c5ecd3d25a96f2f23ea40661f494f932ae2b12ab1977c AS runtime

ENV APP_ENV=production
WORKDIR /workspace

COPY --from=build --chown=node:node /runtime/workers ./services/workers
RUN mkdir -p /workspace/.data && chown node:node /workspace/.data

USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.LTM_WORKER_HEALTH_PORT||'8090')+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "services/workers/dist/main.js"]
