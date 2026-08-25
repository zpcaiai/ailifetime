# Infrastructure
Local composition is a developer convenience. Production infrastructure code includes PostgreSQL/RLS contracts, a checksum/ledger/advisory-lock migration runner, managed-secret/object-store/replay adapters, backup verification and restricted Kubernetes templates under `kubernetes/production`. B44-B47 and B119-B124 enforce the corresponding evidence gates; they do not certify an undeployed region, provider, failover or rollback exercise.

Render Kubernetes templates only with immutable OCI registry digests:

```bash
node tools/kubernetes-production.mjs render \
  --output=.artifacts/kubernetes/production \
  --api-image="$LTM_API_IMAGE" \
  --workers-image="$LTM_WORKERS_IMAGE" \
  --gateway-image="$LTM_GATEWAY_IMAGE" \
  --client-broker-image="$LTM_CLIENT_BROKER_IMAGE" \
  --migrator-image="$LTM_MIGRATOR_IMAGE" \
  --host="$LTM_PRODUCTION_HOST" \
  --oidc-issuer="$LTM_OIDC_ISSUER" \
  --oidc-jwks-url="$LTM_OIDC_JWKS_URL" \
  --oidc-audience="$LTM_OIDC_AUDIENCE" \
  --media-safety-scanner-url="$LTM_MEDIA_SAFETY_SCANNER_URL" \
  --tenant-id="$LTM_TENANT_ID" \
  --release-id="$LTM_RELEASE_ID" \
  --ingress-class="$LTM_INGRESS_CLASS" \
  --ingress-namespace="$LTM_INGRESS_NAMESPACE" \
  --postgres-cidr="$LTM_POSTGRES_CIDR" \
  --postgres-port="$LTM_POSTGRES_PORT" \
  --redis-cidr="$LTM_REDIS_CIDR" \
  --redis-port="$LTM_REDIS_PORT"
```

The renderer validates restricted security contexts, external Secret references, probes, resources, disruption budgets, autoscaling, topology spread, default-deny networking, TLS ingress, the migration Job, and the mandatory HTTPS media-scanner deployment contract. The scanner token is never passed to the renderer: it must be synchronized into the external scanner-credentials Secret. The broker receives one controller-built CA bundle containing both IdP and scanner chains. Cluster admission, external secret synchronization and signed deployment observations remain external gates.
