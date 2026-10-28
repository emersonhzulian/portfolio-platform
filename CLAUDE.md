# portfolio-platform — Claude guide

A public platform-engineering portfolio: `gitops/` is what Argo CD applies to the `portfolio`
namespace of my homelab cluster; `shop/` is the source of the app that runs on it. Start with
`README.md` (architecture, requirements, conventions) and `shop/README.md`.

## Rules

- **Public repository.** Never commit secrets, IPs or LAN hostnames. Credentials come from
  OpenBao via `ExternalSecret`, or are generated in-cluster (External Secrets' Password generator).
- **Cluster-side pieces live in the homelab repo (private), not here:** the Argo CD AppProjects and
  root Application, LAN routes, and the operators (Argo CD, Kyverno, Argo Rollouts, Chaos Mesh,
  Strimzi, CloudNativePG, cert-manager, Envoy Gateway, External Secrets, OpenTelemetry).
  A change here can't widen what the AppProjects allow.
- **Every folder under `gitops/{platform,observability,apps}` is one Argo CD Application**,
  declared in `gitops/argocd/<group>/` and listed in that folder's `kustomization.yaml`.
- **Network:** the namespace is default-deny both ways. Native `NetworkPolicy` first;
  `ciliumnetworkpolicy-*.yaml` only for egress by hostname (add the app to `dns-proxy`), the API
  server and the kubelets. Shared policies live in `gitops/platform/network-policies/`; one that
  selects a single app lives in that app's folder.
- **An app's own pieces live in its folder** (dashboard, network policy, monitors, Kafka
  topics). Exception: authentik blueprints and their client Secrets stay in
  `gitops/platform/authentik/`, which mounts and reads them. Moving a resource between Argo CD
  apps can prune it before the new app adopts it (each app polls on its own): a stateless one
  just has a short gap, a stateful one (KafkaTopic, PVC, database) is deleted with its data.
- **Policies (Kyverno, CEL):** pods get the node-pool `nodeSelector` automatically, and the
  OpenTelemetry agent when labelled `portfolio.emersonzulian.dev/instrument: dotnet|nodejs`;
  images must be pinned; pods need `app.kubernetes.io/name`; containers need requests, a memory
  limit, a readiness probe and `runAsNonRoot`. Test a
  new mutating policy with a probe policy first - a failing patch with `failurePolicy: Fail`
  denies every pod.
- **Replicas:** spread with `topologySpreadConstraints` on `kubernetes.io/hostname` plus
  `matchLabelKeys: [pod-template-hash]` (`rollouts-pod-template-hash` for a Rollout, which also
  needs `OTEL_SERVICE_NAME` pinned - the operator would name it after the ReplicaSet). Size
  requests from measured use, not from the limit.
- **ServiceMonitors/PodMonitors/PrometheusRules** carry `prometheus.homelab/instance: portfolio` (the cluster's
  central Prometheus skips them).
- **Before pushing:** `kubectl kustomize` every changed folder from a clean checkout (an
  uncommitted file referenced by a kustomization breaks a whole Argo CD group). Commit before
  `git pull --rebase`.
- Images: `ghcr.io/emersonhzulian/portfolio-platform/<service>:0.1.<run>`, built by
  `.github/workflows/shop.yml`; Renovate (`renovate.json5`) bumps the tags in `gitops/apps/shop`.
