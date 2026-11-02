FROM node:26.0.0-bookworm-slim@sha256:3529ef69feecddd94e9c5ecd3d25a96f2f23ea40661f494f932ae2b12ab1977c AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN npm install --global --ignore-scripts pnpm@10.12.4 \
    && test "$(pnpm --version)" = "10.12.4"
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ltm/integration-gateway... run build \
    && pnpm --filter @ltm/integration-gateway deploy --prod --legacy /runtime/integration-gateway
RUN find /runtime/integration-gateway -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf '{}' + \
    && find /runtime/integration-gateway -type f \( -name '*.test.js' -o -name '*.test.cjs' -o -name '*.test.mjs' -o -name '*.spec.js' -o -name '*.spec.cjs' -o -name '*.spec.mjs' -o -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' -o -name '*.tsbuildinfo' \) -delete \
    && find /runtime/integration-gateway/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \( -name '@types+*' -o -name 'typescript@*' -o -name 'tsx@*' \) -exec rm -rf '{}' + \
    && find /runtime/integration-gateway/node_modules -name '@types' -exec rm -rf '{}' + \
    && find /runtime/integration-gateway/node_modules -type l \( -name typescript -o -name tsx \) -delete \
    && node -e "const fs=require('node:fs');const file='/runtime/integration-gateway/package.json';const value=JSON.parse(fs.readFileSync(file,'utf8'));delete value.devDependencies;fs.writeFileSync(file,JSON.stringify(value));" \
    && test -f /runtime/integration-gateway/dist/main.js \
    && test -z "$(find /runtime/integration-gateway -type f \( -name '*.test.js' -o -name '*.test.cjs' -o -name '*.test.mjs' -o -name '*.spec.js' -o -name '*.spec.cjs' -o -name '*.spec.mjs' -o -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' -o -name '*.tsbuildinfo' \) -print -quit)" \
    && test -z "$(find /runtime/integration-gateway/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \( -name '@types+*' -o -name 'typescript@*' -o -name 'tsx@*' \) -print -quit)"

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:9b945e92c1b5463a4b75f11e8417515e4bea7355f6adfd79ec220fbbe905dda8 AS runtime

ENV APP_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8081
WORKDIR /workspace

COPY --from=build --chown=10001:10001 /runtime/integration-gateway ./services/integration-gateway

USER 10001:10001
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8081')+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["services/integration-gateway/dist/main.js"]
