import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KubernetesProductionError,
  renderProductionManifests,
  validateRenderedProductionManifests,
} from "./kubernetes-production.mjs";

test("renders immutable, restricted, highly available production Kubernetes resources", (context) => {
  const output = temporaryOutput(context);
  const result = renderProductionManifests({ ...validOptions(), output });
  assert.equal(result.status, "PASS");
  assert.equal(result.files.length, 12);
  assert.equal(result.resources, 32);
  assert.equal(result.workloadImages.length, 5);
  assert.equal(result.workloadImages.every((value) => value.includes("@sha256:")), true);
  assert.equal(result.externalCertification, false);
  assert.equal(validateRenderedProductionManifests(output).status, "PASS");
});

test("worker container and production probe share the configured health port", (context) => {
  const dockerfile = readFileSync("services/workers/Dockerfile", "utf8");
  assert.match(dockerfile, /process\.env\.LTM_WORKER_HEALTH_PORT\|\|'8090'/);
  const output = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output });
  const workers = readFileSync(join(output, "workers.yaml"), "utf8");
  assert.match(workers, /name: LTM_WORKER_HEALTH_PORT\n\s+value: "8090"/);
  assert.match(workers, /name: health\n\s+containerPort: 8090/);
  assert.equal([...workers.matchAll(/port: health/g)].length, 3);
  assert.match(workers, /ltm\.openai\.com\/external-command-batches: "18"/);
  assert.match(workers, /ltm\.openai\.com\/external-callback-route-contracts: "19"/);
  assert.match(workers, /runAsUser: 10001[\s\S]*runAsGroup: 10001[\s\S]*fsGroup: 10001[\s\S]*fsGroupChangePolicy: OnRootMismatch/);
  assert.match(workers, /name: workload-token[\s\S]*projected:\n\s+defaultMode: 0440/);
});

test("API and worker mount the same signed consent catalog as a regular subPath file", (context) => {
  const output = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output });
  for (const name of ["api.yaml", "workers.yaml"]) {
    const manifest = readFileSync(join(output, name), "utf8");
    assert.match(manifest, /name: LTM_CONSENT_POLICY_CATALOG_FILE\n\s+value: \/var\/run\/secrets\/ltm-consent-policy\/catalog\.json/);
    assert.match(manifest, /name: LTM_CONSENT_POLICY_TRUST_KEYS_JSON\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: ltm-production-consent-policy\n\s+key: trust-keys\.json/);
    assert.match(manifest, /name: consent-policy\n\s+mountPath: \/var\/run\/secrets\/ltm-consent-policy\/catalog\.json\n\s+subPath: catalog\.json\n\s+readOnly: true/);
  }

  const configMap = readFileSync(join(output, "configmap.yaml"), "utf8");
  assert.doesNotMatch(configMap, /(?:TOKEN|CATALOG)_FILE:/u);

  const drifted = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: drifted });
  const workersPath = join(drifted, "workers.yaml");
  writeFileSync(
    workersPath,
    readFileSync(workersPath, "utf8").replace("subPath: catalog.json", "subPath: catalog-link.json"),
  );
  assert.throws(
    () => validateRenderedProductionManifests(drifted),
    (error) => error instanceof KubernetesProductionError && error.code === "KUBERNETES_CONSENT_POLICY_INVALID",
  );
});

test("gateway projected API and workload tokens are readable only by the restricted pod group", (context) => {
  const output = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output });
  const gateway = readFileSync(join(output, "integration-gateway.yaml"), "utf8");
  assert.match(gateway, /runAsUser: 10001[\s\S]*runAsGroup: 10001[\s\S]*fsGroup: 10001[\s\S]*fsGroupChangePolicy: OnRootMismatch/);
  assert.equal([...gateway.matchAll(/defaultMode: 0440/g)].length, 2);
  assert.doesNotMatch(gateway, /defaultMode: 0400/);
  assert.match(
    gateway,
    /name: LTM_SUPPLY_EVENT_AUTHORITIES_REFERENCE\n\s+value: secret-manager:ltm\/production\/supply-event-authorities/,
  );
  assert.match(
    gateway,
    /name: LTM_DIRECT_EVIDENCE_AUTHORITIES_REFERENCE\n\s+value: secret-manager:ltm\/production\/direct-evidence-authorities/,
  );
  assert.match(gateway, /audience: sts\.amazonaws\.com/);
  const policy = JSON.parse(readFileSync(join(output, "integration-gateway-readiness-iam-policy.json"), "utf8"));
  assert.deepEqual(policy.Statement.flatMap((statement) => statement.Action).sort(), [
    "kms:DescribeKey",
    "kms:GenerateDataKeyWithoutPlaintext",
    "s3:GetBucketObjectLockConfiguration",
    "s3:GetBucketVersioning",
    "s3:ListBucket",
  ]);
});

test("gateway readiness IAM policy rejects a missing or broadened cloud action", (context) => {
  const missing = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: missing });
  const missingPath = join(missing, "integration-gateway-readiness-iam-policy.json");
  const missingPolicy = JSON.parse(readFileSync(missingPath, "utf8"));
  missingPolicy.Statement[0].Action.pop();
  writeFileSync(missingPath, `${JSON.stringify(missingPolicy, null, 2)}\n`);
  assert.throws(
    () => validateRenderedProductionManifests(missing),
    (error) => error.code === "KUBERNETES_GATEWAY_READINESS_IAM_INVALID",
  );

  const broadened = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: broadened });
  const broadenedPath = join(broadened, "integration-gateway-readiness-iam-policy.json");
  const broadenedPolicy = JSON.parse(readFileSync(broadenedPath, "utf8"));
  broadenedPolicy.Statement[0].Action.push("s3:GetObject");
  writeFileSync(broadenedPath, `${JSON.stringify(broadenedPolicy, null, 2)}\n`);
  assert.throws(
    () => validateRenderedProductionManifests(broadened),
    (error) => error.code === "KUBERNETES_GATEWAY_READINESS_IAM_INVALID",
  );
});

test("API trusts the deployed broker CA and the broker projects scanner credentials plus a merged egress CA bundle", (context) => {
  const output = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output });
  const config = readFileSync(join(output, "configmap.yaml"), "utf8");
  assert.equal([...config.matchAll(/https:\/\/ltm-client-integration-broker\.ltm-production\.svc:8443/g)].length, 2);
  const api = readFileSync(join(output, "api.yaml"), "utf8");
  assert.match(api, /name: NODE_EXTRA_CA_CERTS\n\s+value: \/var\/run\/secrets\/ltm-client-broker-ca\/ca\.crt/);
  assert.match(api, /secretName: ltm-production-client-integration-broker-tls/);
  const broker = readFileSync(join(output, "client-integration-broker.yaml"), "utf8");
  assert.equal([...broker.matchAll(/scheme: HTTPS/g)].length, 3);
  assert.match(broker, /secretName: ltm-production-client-integration-broker-credentials/);
  assert.match(broker, /name: LTM_MEDIA_SAFETY_SCANNER_URL\n\s+value: "https:\/\/media-safety\.example\.com"/);
  assert.match(broker, /name: LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE\n\s+value: \/var\/run\/secrets\/ltm-media-scanner\/token/);
  assert.match(broker, /secretName: ltm-production-client-integration-broker-scanner-credentials/);
  assert.match(broker, /name: NODE_EXTRA_CA_CERTS\n\s+value: \/var\/run\/secrets\/ltm-egress-ca-bundle\/ca-bundle\.pem/);
  assert.match(broker, /secretName: ltm-production-client-integration-broker-egress-ca-bundle/);
  assert.match(broker, /key: idp-ca\.crt\n\s+path: sources\/idp-ca\.crt/);
  assert.match(broker, /key: scanner-ca\.crt\n\s+path: sources\/scanner-ca\.crt/);
  assert.match(broker, /audience: sts\.amazonaws\.com/);
  const networking = readFileSync(join(output, "networking.yaml"), "utf8");
  assert.match(
    networking,
    /name: allow-https-egress[\s\S]*values: \["api", "workers", "integration-gateway", "client-integration-broker"\][\s\S]*protocol: TCP\n\s+port: 443/,
  );
});

test("production rendering and static validation fail closed without the scanner contract", (context) => {
  const missingScanner = validOptions();
  delete missingScanner.mediaSafetyScannerUrl;
  assert.throws(
    () => renderProductionManifests({ ...missingScanner, output: temporaryOutput(context) }),
    (error) => error instanceof KubernetesProductionError && error.code === "KUBERNETES_ARGUMENT_REQUIRED",
  );
  assert.throws(
    () => renderProductionManifests({
      ...validOptions(),
      output: temporaryOutput(context),
      mediaSafetyScannerUrl: "http://media-safety.example.com",
    }),
    (error) => error instanceof KubernetesProductionError && error.code === "KUBERNETES_URL_INVALID",
  );
  assert.throws(
    () => renderProductionManifests({
      ...validOptions(),
      output: temporaryOutput(context),
      mediaSafetyScannerUrl: "https://media-safety.example.com:8443",
    }),
    (error) => error instanceof KubernetesProductionError && error.code === "KUBERNETES_URL_INVALID",
  );

  const missingProjection = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: missingProjection });
  const brokerPath = join(missingProjection, "client-integration-broker.yaml");
  writeFileSync(
    brokerPath,
    readFileSync(brokerPath, "utf8").replace("LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE", "LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE_REMOVED"),
  );
  assert.throws(
    () => validateRenderedProductionManifests(missingProjection),
    (error) => error.code === "KUBERNETES_MEDIA_SCANNER_CONFIG_INVALID",
  );

  const incompleteBundle = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: incompleteBundle });
  const incompleteBundlePath = join(incompleteBundle, "client-integration-broker.yaml");
  writeFileSync(
    incompleteBundlePath,
    readFileSync(incompleteBundlePath, "utf8").replace("scanner-ca.crt", "scanner-ca.crt.removed"),
  );
  assert.throws(
    () => validateRenderedProductionManifests(incompleteBundle),
    (error) => error.code === "KUBERNETES_MEDIA_SCANNER_CONFIG_INVALID",
  );

  const missingEgress = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: missingEgress });
  const networkingPath = join(missingEgress, "networking.yaml");
  writeFileSync(
    networkingPath,
    readFileSync(networkingPath, "utf8").replace(
      'values: ["api", "workers", "integration-gateway", "client-integration-broker"]',
      'values: ["api", "workers", "integration-gateway"]',
    ),
  );
  assert.throws(
    () => validateRenderedProductionManifests(missingEgress),
    (error) => error.code === "KUBERNETES_MEDIA_SCANNER_EGRESS_INVALID",
  );
});

test("release candidate workflow passes only the required scanner origin and never a scanner token", () => {
  const workflow = readFileSync(".github/workflows/production-release-candidate.yml", "utf8");
  assert.match(workflow, /media_safety_scanner_url:[\s\S]*required: true/);
  assert.match(workflow, /--media-safety-scanner-url="\$\{LTM_MEDIA_SAFETY_SCANNER_URL\}"/);
  assert.doesNotMatch(workflow, /MEDIA_SAFETY_SCANNER_TOKEN|media[_-]safety[_-]scanner[_-]token/i);
});

test("production SPA OIDC is complete, issuer-bound, exact-redirect, and refresh-token-free", (context) => {
  const output = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output });
  const config = readFileSync(join(output, "configmap.yaml"), "utf8");
  assert.match(config, /LTM_WEB_OIDC_AUTHORIZATION_ENDPOINT: "https:\/\/identity\.example\.com\/oauth2\/authorize"/);
  assert.match(config, /LTM_WEB_OIDC_TOKEN_ENDPOINT: "https:\/\/identity\.example\.com\/oauth2\/token"/);
  assert.match(config, /LTM_WEB_OIDC_CLIENT_ID: "ltm-production-spa"/);
  assert.match(config, /LTM_WEB_OIDC_REDIRECT_URI: "https:\/\/ltm\.example\.com\/auth\/callback"/);
  assert.match(config, /LTM_WEB_OIDC_SCOPES: "openid profile email"/);

  for (const name of ["oidcAuthorizationEndpoint", "oidcTokenEndpoint", "oidcClientId", "oidcRedirectUri", "oidcScopes"]) {
    const options = validOptions();
    delete options[name];
    assert.throws(
      () => renderProductionManifests({ ...options, output: temporaryOutput(context) }),
      (error) => error.code === "KUBERNETES_ARGUMENT_REQUIRED",
    );
  }
  assert.throws(
    () => renderProductionManifests({ ...validOptions(), output: temporaryOutput(context), oidcTokenEndpoint: "https://tokens.example.com/oauth2/token" }),
    (error) => error.code === "KUBERNETES_OIDC_BROWSER_INVALID",
  );
  assert.throws(
    () => renderProductionManifests({ ...validOptions(), output: temporaryOutput(context), oidcJwksUrl: "https://keys.example.com/.well-known/jwks.json" }),
    (error) => error.code === "KUBERNETES_OIDC_JWKS_INVALID",
  );
  assert.throws(
    () => renderProductionManifests({ ...validOptions(), output: temporaryOutput(context), oidcRedirectUri: "https://ltm.example.com/oidc/callback" }),
    (error) => error.code === "KUBERNETES_OIDC_BROWSER_INVALID",
  );
  assert.throws(
    () => renderProductionManifests({ ...validOptions(), output: temporaryOutput(context), oidcScopes: "openid offline_access" }),
    (error) => error.code === "KUBERNETES_OIDC_BROWSER_INVALID",
  );

  const drifted = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: drifted });
  const driftedConfig = join(drifted, "configmap.yaml");
  writeFileSync(
    driftedConfig,
    readFileSync(driftedConfig, "utf8").replace(
      "https://identity.example.com/oauth2/token",
      "https://tokens.example.com/oauth2/token",
    ),
  );
  assert.throws(
    () => validateRenderedProductionManifests(drifted),
    (error) => error.code === "KUBERNETES_OIDC_BROWSER_INVALID",
  );

  const driftedJwks = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: driftedJwks });
  const driftedJwksConfig = join(driftedJwks, "configmap.yaml");
  writeFileSync(
    driftedJwksConfig,
    readFileSync(driftedJwksConfig, "utf8").replace(
      "https://identity.example.com/.well-known/jwks.json",
      "https://keys.example.com/.well-known/jwks.json",
    ),
  );
  assert.throws(
    () => validateRenderedProductionManifests(driftedJwks),
    (error) => error.code === "KUBERNETES_OIDC_JWKS_INVALID",
  );
});

test("release workflow requires and forwards every public SPA OIDC field without a client secret", () => {
  const workflow = readFileSync(".github/workflows/production-release-candidate.yml", "utf8");
  for (const input of [
    "oidc_authorization_endpoint", "oidc_token_endpoint", "oidc_client_id", "oidc_redirect_uri", "oidc_scopes",
  ]) assert.match(workflow, new RegExp(`${input}:[\\s\\S]*?required: true`));
  for (const argument of [
    "oidc-authorization-endpoint", "oidc-token-endpoint", "oidc-client-id", "oidc-redirect-uri", "oidc-scopes",
  ]) assert.match(workflow, new RegExp(`--${argument}=`));
  assert.doesNotMatch(workflow, /OIDC_CLIENT_SECRET|oidc_client_secret|oidc-client-secret/);
  assert.match(workflow, /azure\/setup-kubectl@829323503d1be3d00ca8346e5391ca0b07a9ab0d/);
  assert.match(workflow, /version: v1\.36\.2/);
  assert.match(workflow, /kubectl version --client --output=json/);
  assert.match(workflow, /kubectl-toolchain\.json[\s\S]*SHA256SUMS/);
});

test("rejects mutable/reused images and non-production endpoints", (context) => {
  assert.throws(
    () => renderProductionManifests({ ...validOptions(), output: temporaryOutput(context), apiImage: "registry.example.com/ltm-api:latest" }),
    (error) => error instanceof KubernetesProductionError && error.code === "KUBERNETES_IMAGE_INVALID",
  );
  const reused = validOptions();
  reused.gatewayImage = reused.apiImage;
  assert.throws(
    () => renderProductionManifests({ ...reused, output: temporaryOutput(context) }),
    (error) => error.code === "KUBERNETES_IMAGE_REUSED",
  );
  const aliased = validOptions();
  aliased.gatewayImage = `registry.other.example/aliased-gateway@sha256:${"a".repeat(64)}`;
  assert.throws(
    () => renderProductionManifests({ ...aliased, output: temporaryOutput(context) }),
    (error) => error.code === "KUBERNETES_IMAGE_REUSED",
  );
  assert.throws(
    () => renderProductionManifests({ ...validOptions(), output: temporaryOutput(context), host: "ltm.example.test" }),
    (error) => error.code === "KUBERNETES_HOST_INVALID",
  );
  assert.throws(
    () => renderProductionManifests({ ...validOptions(), output: temporaryOutput(context), postgresCidr: "0.0.0.0/0" }),
    (error) => error.code === "KUBERNETES_CIDR_PUBLIC",
  );
  assert.throws(
    () => renderProductionManifests({ ...validOptions(), output: temporaryOutput(context), redisCidr: "10.24.0.0/24" }),
    (error) => error.code === "KUBERNETES_CIDR_SCOPE_INVALID",
  );
  assert.throws(
    () => renderProductionManifests({ ...validOptions(), output: temporaryOutput(context), postgresCidr: "10.0.0.0/8" }),
    (error) => error.code === "KUBERNETES_CIDR_SCOPE_INVALID",
  );
});

test("static validation rejects weakened or comment-spoofed restricted workload controls", (context) => {
  const output = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output });
  const path = join(output, "api.yaml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "readOnlyRootFilesystem: true",
      "readOnlyRootFilesystem: false\n            # readOnlyRootFilesystem: true",
    ),
  );
  assert.throws(
    () => validateRenderedProductionManifests(output),
    (error) => error instanceof KubernetesProductionError && error.code === "KUBERNETES_RESTRICTED_WORKLOAD_INVALID",
  );

  const privileged = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: privileged });
  const privilegedPath = join(privileged, "migration-job.yaml");
  writeFileSync(
    privilegedPath,
    readFileSync(privilegedPath, "utf8").replace("privileged: false", "privileged: true\n            # privileged: false"),
  );
  assert.throws(
    () => validateRenderedProductionManifests(privileged),
    (error) => error instanceof KubernetesProductionError && error.code === "KUBERNETES_RESTRICTED_WORKLOAD_INVALID",
  );
});

test("static validation rejects unresolved values and missing network isolation", (context) => {
  const unresolved = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: unresolved });
  const config = join(unresolved, "configmap.yaml");
  writeFileSync(config, `${readFileSync(config, "utf8")}\n# __LTM_MISSING__\n`);
  assert.throws(() => validateRenderedProductionManifests(unresolved), (error) => error.code === "KUBERNETES_VALUE_UNRESOLVED");

  const weakened = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: weakened });
  const network = join(weakened, "networking.yaml");
  writeFileSync(network, readFileSync(network, "utf8").replace("name: default-deny", "name: default-open"));
  assert.throws(() => validateRenderedProductionManifests(weakened), (error) => error.code === "KUBERNETES_RESOURCE_SET_INVALID");

  const publicDatabase = temporaryOutput(context);
  renderProductionManifests({ ...validOptions(), output: publicDatabase });
  const publicNetwork = join(publicDatabase, "networking.yaml");
  writeFileSync(publicNetwork, readFileSync(publicNetwork, "utf8").replace("10.24.0.10/32", "0.0.0.0/0"));
  assert.throws(() => validateRenderedProductionManifests(publicDatabase), (error) => error.code === "KUBERNETES_CIDR_PUBLIC");
});

function validOptions() {
  return {
    apiImage: `registry.example.com/ltm-api@sha256:${"a".repeat(64)}`,
    workersImage: `registry.example.com/ltm-workers@sha256:${"b".repeat(64)}`,
    gatewayImage: `registry.example.com/ltm-gateway@sha256:${"c".repeat(64)}`,
    clientBrokerImage: `registry.example.com/ltm-client-broker@sha256:${"d".repeat(64)}`,
    migratorImage: `registry.example.com/ltm-migrator@sha256:${"e".repeat(64)}`,
    host: "ltm.example.com",
    oidcIssuer: "https://identity.example.com/",
    oidcJwksUrl: "https://identity.example.com/.well-known/jwks.json",
    oidcAudience: "https://ltm.example.com",
    oidcAuthorizationEndpoint: "https://identity.example.com/oauth2/authorize",
    oidcTokenEndpoint: "https://identity.example.com/oauth2/token",
    oidcClientId: "ltm-production-spa",
    oidcRedirectUri: "https://ltm.example.com/auth/callback",
    oidcScopes: "openid profile email",
    mediaSafetyScannerUrl: "https://media-safety.example.com",
    tenantId: "tenant-production",
    releaseId: "release-20260824-001",
    ingressClass: "nginx",
    ingressNamespace: "ingress-nginx",
    postgresCidr: "10.24.0.10/32",
    postgresPort: "5432",
    redisCidr: "10.25.0.10/32",
    redisPort: "6380",
  };
}

function temporaryOutput(context) {
  const parent = mkdtempSync(join(tmpdir(), "ltm-kubernetes-production-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  return join(parent, "rendered");
}
