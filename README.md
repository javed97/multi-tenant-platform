# Multi-Tenant Kubernetes Platform

A Kubernetes platform that hosts multiple isolated tenant websites on shared infrastructure, with TLS ingress, autoscaling, network isolation, event streaming, observability, and a CI/CD pipeline. Each tenant lives in its own namespace, gets its own subdomain over HTTPS, and is fenced off from the others by default-deny NetworkPolicies and ResourceQuotas. New tenants are onboarded with a single `helm install`.

Built end-to-end as a portfolio project to demonstrate multi-tenancy, platform engineering, and event-driven thinking on Kubernetes. Runs locally on a `kind` cluster — every architectural decision is portable to a managed cluster (EKS/GKE/AKS); see [Production gap](#production-gap) for what changes.

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Cluster | kind | Free, fast iteration loop; standard upstream Kubernetes |
| CNI | Calico | Enforces NetworkPolicies (kind's default `kindnet` does not) |
| Packaging | Helm | One templated chart per tenant; release history enables one-command rollback |
| Ingress | ingress-nginx | Most widely deployed, well-documented controller |
| TLS | cert-manager + self-signed `ClusterIssuer` | Local cluster can't satisfy Let's Encrypt's HTTP-01 challenge; swap issuer for prod |
| Events | Apache Kafka 3.7 in KRaft mode | No ZooKeeper dependency; single-node sufficient for the demo |
| Observability | kube-prometheus-stack | Prometheus + Grafana, pre-wired |
| App | Node.js (Express + KafkaJS) | Minimal sample with a CPU-burn endpoint to drive HPA |
| CI/CD | GitHub Actions, image push to GHCR | Zero extra infra; auto-authenticates with the repo |

## What it does

**Multi-tenant deployment.** Three tenants (`user1`, `user2`, `user3`) each live in their own namespace and reach the cluster at `https://userN.example.com`. Per-tenant resources: Deployment, Service, Ingress (with TLS), NetworkPolicy (default-deny + targeted allow rules), ResourceQuota, PodDisruptionBudget, and HPA. Adding a fourth tenant is one command:

```bash
helm install user4 ./helm-chart -f tenants/user4.values.yaml
```

No cluster restart, no template edits — `tenants/userN.values.yaml` is the only per-tenant file.

**Tenant isolation.** Each namespace defaults to denying all ingress and egress; the chart's NetworkPolicy templates open the minimum needed (ingress from `ingress-nginx`, DNS, etc.). Calico enforces this at the dataplane — without it, `NetworkPolicy` objects would exist but be silently ignored.

**Scaling under load.** Each tenant's HPA scales 2 → 6 replicas at 50% CPU target. The sample app exposes `/burn`, a deliberately CPU-heavy endpoint used to drive realistic spikes with `hey`. ResourceQuotas cap any single tenant at 1 CPU / 1Gi requests and 10 pods so a noisy tenant can't starve the others. PDBs (`minAvailable: 1`) keep each tenant up during voluntary disruptions like node drains.

**Event-driven pipeline.** A single-node Kafka StatefulSet (KRaft) runs in-cluster. The sample app publishes a `WebsiteCreated` event to the `website-events` topic on startup. The CI/CD pipeline emits a `DeploymentSucceeded` event payload on every successful deploy.

**CI/CD.** `.github/workflows/deploy.yml` runs on every push to `main`:
1. Build and push the image to GHCR, tagged with the short commit SHA (immutable) and `latest` (moving).
2. `helm lint` and `helm template` for every tenant — catches template/value errors before deploy.
3. Deploy step (simulated locally — see [Production gap](#production-gap)).
4. Rollback demo, runs only on manual `workflow_dispatch`.
5. Emits a `DeploymentSucceeded` event.

**Observability.** kube-prometheus-stack provides Prometheus scraping and Grafana dashboards out of the box; tenant pods are auto-discovered.

## Repository layout

```
app/                       Node.js sample app + Dockerfile
helm-chart/                One chart, installed once per tenant
  templates/               Deployment, Service, Ingress, NetworkPolicy,
                           ResourceQuota, PDB, HPA
tenants/                   Per-tenant values files (user1..user4)
kafka/kafka.yaml           Single-node KRaft Kafka + Service
kind-cluster.yaml          Cluster config (host ports 80/443 mapped in)
calico-installation.yaml   Calico CNI install spec
selfsigned-issuer.yaml     cert-manager ClusterIssuer
.github/workflows/         CI/CD pipeline
docs/screenshots/          Proof-of-work screenshots for each capability
```

## Quick start

Prereqs: `docker`, `kubectl`, `helm`, `kind`, `hey`.

```bash
# 1. Cluster + CNI + ingress + cert-manager + monitoring
kind create cluster --config kind-cluster.yaml --name platform
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/tigera-operator.yaml
kubectl apply -f calico-installation.yaml

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo add jetstack https://charts.jetstack.io
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace
helm install cert-manager  jetstack/cert-manager       -n cert-manager   --create-namespace --set installCRDs=true
kubectl apply -f selfsigned-issuer.yaml
helm install monitoring    prometheus-community/kube-prometheus-stack -n monitoring --create-namespace

# 2. Kafka
kubectl apply -f kafka/kafka.yaml

# 3. App image (build locally, then load into kind)
docker build -t tenant-website:v3 ./app
kind load docker-image tenant-website:v3 --name platform

# 4. Tenants
for u in user1 user2 user3; do
  helm install $u ./helm-chart -f tenants/$u.values.yaml
done

# 5. Local DNS (the only piece that doesn't generalize — see Production gap)
sudo sh -c 'echo "127.0.0.1 user1.example.com user2.example.com user3.example.com" >> /etc/hosts'

# 6. Verify
for u in user1 user2 user3; do
  curl -sk -o /dev/null -w "$u %{http_code}\n" https://$u.example.com
done
```

Consume the Kafka topic:

```bash
kubectl exec -n kafka kafka-0 -- /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka.kafka.svc.cluster.local:9092 \
  --topic website-events --partition 0 --offset earliest \
  --max-messages 20 --timeout-ms 10000
```

Roll back a tenant:

```bash
helm history user1
helm rollback user1 <revision>
```

Tear down everything:

```bash
kind delete cluster --name platform
```

## Production gap

Honest list of what's local-only and the one-line fix for each. Every other architectural decision in this repo is production-shaped.

| Local choice | Production swap |
| --- | --- |
| `kind` cluster on laptop | Managed Kubernetes (EKS / GKE / AKS), provisioned via Terraform |
| `selfsigned-issuer` ClusterIssuer | `letsencrypt-prod` ClusterIssuer — one value change in the chart |
| `/etc/hosts` entries for `userN.example.com` | Real domain with DNS records pointing at the ingress LB |
| `kind load docker-image` | Already publishing to GHCR; pull from there |
| Single-broker Kafka, no replication | 3-broker StatefulSet with PVCs, `replication.factor=3`, `min.insync.replicas=2` |
| CI/CD deploy step is simulated | Add a kubeconfig secret + one `helm upgrade --install` line — pipeline structure is already correct |

## Trade-offs and known issues

- **NetworkPolicy + Kafka.** The default-deny policy on each tenant blocks egress to the `kafka` namespace. For the demo, this was temporarily relaxed on `user1` by deleting the `user1-default-deny` policy, then restored. The clean fix is an explicit egress rule in the chart's NetworkPolicy template allowing `kafka.kafka:9092`.
- **Self-signed TLS.** `curl -sk` and browser warnings are expected locally; see [Production gap](#production-gap).
- **CI/CD deploy is simulated.** GitHub-hosted runners can't reach a kind cluster on a laptop behind a home router. The pipeline lints, renders, and pushes a real image; the final `helm upgrade` is described but not executed. See [Production gap](#production-gap).

## Screenshots

All proof-of-work is under `docs/screenshots/`:

- Multi-tenant deployment and dynamic onboarding: `01`, `02`, `05`, `06`, `07`, `08`
- Rollback: `04`
- Resources, probes, PDB, NetworkPolicy: `10`, `11`
- HPA baseline, scale-up, scale-down: `12`, `13`, `14`
- Grafana dashboard: `15`
- Kafka events consumed: `16`
- CI/CD pipeline (green run): `17`
