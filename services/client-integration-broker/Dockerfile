FROM node:26.0.0-bookworm-slim@sha256:3529ef69feecddd94e9c5ecd3d25a96f2f23ea40661f494f932ae2b12ab1977c AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN npm install --global --ignore-scripts pnpm@10.12.4 \
    && test "$(pnpm --version)" = "10.12.4"
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ltm/client-integration-broker... run build \
    && pnpm --filter @ltm/client-integration-broker deploy --prod --legacy /runtime/client-integration-broker
RUN find /runtime/client-integration-broker -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf '{}' + \
    && find /runtime/client-integration-broker -type f \( -name '*.test.js' -o -name '*.test.cjs' -o -name '*.test.mjs' -o -name '*.spec.js' -o -name '*.spec.cjs' -o -name '*.spec.mjs' -o -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' -o -name '*.tsbuildinfo' \) -delete \
    && find /runtime/client-integration-broker/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \( -name '@types+*' -o -name 'typescript@*' -o -name 'tsx@*' \) -exec rm -rf '{}' + \
    && find /runtime/client-integration-broker/node_modules -name '@types' -exec rm -rf '{}' + \
    && find /runtime/client-integration-broker/node_modules -type l \( -name typescript -o -name tsx \) -delete \
    && node -e "const fs=require('node:fs');const file='/runtime/client-integration-broker/package.json';const value=JSON.parse(fs.readFileSync(file,'utf8'));delete value.devDependencies;fs.writeFileSync(file,JSON.stringify(value));" \
    && test -f /runtime/client-integration-broker/dist/main.js \
    && test -z "$(find /runtime/client-integration-broker -type f \( -name '*.test.js' -o -name '*.test.cjs' -o -name '*.test.mjs' -o -name '*.spec.js' -o -name '*.spec.cjs' -o -name '*.spec.mjs' -o -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' -o -name '*.tsbuildinfo' \) -print -quit)" \
    && test -z "$(find /runtime/client-integration-broker/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \( -name '@types+*' -o -name 'typescript@*' -o -name 'tsx@*' \) -print -quit)"

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:10ec8cb93ef461563da50d4eb8dfac7d048783826825bf5b07510c2f34c14315 AS runtime

ENV APP_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8443
WORKDIR /workspace

COPY --from=build --chown=10001:10001 /runtime/client-integration-broker ./services/client-integration-broker

USER 10001:10001
EXPOSE 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const fs=require('node:fs'),https=require('node:https');const ca=fs.readFileSync(process.env.LTM_BROKER_TLS_CA_FILE||'/var/run/secrets/ltm-broker-tls/ca.crt');const r=https.request({hostname:'127.0.0.1',port:process.env.PORT||'8443',path:'/health/ready',servername:'ltm-client-integration-broker.ltm-production.svc',ca,timeout:4000},x=>{if(x.statusCode!==200)process.exit(1);x.resume()});r.on('timeout',()=>r.destroy());r.on('error',()=>process.exit(1));r.end()"]

CMD ["services/client-integration-broker/dist/main.js"]
