# Multi-Tenant Website Platform

DevOps assignment. A small Kubernetes platform that hosts multiple tenant websites in isolated namespaces, with TLS ingress, autoscaling, network policies, Kafka events, Prometheus/Grafana, and a GitHub Actions pipeline.

Stack: kind (local cluster), Calico (network policies), Helm, ingress-nginx, cert-manager (self-signed), kube-prometheus-stack, Apache Kafka 3.7 (KRaft, single node), Node.js sample app.

## Repo layout

```
app/                  Node.js sample app (Express + KafkaJS)
helm-chart/           One chart, installed once per tenant
tenants/              Per-tenant values files (user1..user4)
kafka/                Single-node Kafka StatefulSet + Service
kind-cluster.yaml     Cluster config (ports 80/443 mapped to host)
calico-installation.yaml
selfsigned-issuer.yaml
.github/workflows/    CI/CD pipeline
docs/screenshots/     Proof-of-work screenshots
```

## Quick start (local)

Prereqs: docker, kubectl, helm, kind, hey.

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
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set installCRDs=true
kubectl apply -f selfsigned-issuer.yaml
helm install monitoring prometheus-community/kube-prometheus-stack -n monitoring --create-namespace

# 2. Kafka
kubectl apply -f kafka/kafka.yaml

# 3. App image
docker build -t tenant-website:v3 ./app
kind load docker-image tenant-website:v3 --name platform

# 4. Tenants
for u in user1 user2 user3; do
  helm install $u ./helm-chart -f tenants/$u.values.yaml
done

# 5. Local DNS
sudo sh -c 'echo "127.0.0.1 user1.example.com user2.example.com user3.example.com" >> /etc/hosts'

# 6. Verify
for u in user1 user2 user3; do curl -sk -o /dev/null -w "$u %{http_code}\n" https://$u.example.com; done
```

## Deliverables map

All screenshots are in `docs/screenshots/`.

### 1. Multi-tenant deployment & dynamic domain mapping
- 3 tenants in their own namespaces, each gets deployment, service, ingress, NetworkPolicy, ResourceQuota, PDB, HPA.
- TLS via cert-manager `selfsigned-issuer` (production would swap in Let's Encrypt).
- Dynamic onboarding: a new tenant is just `helm install user4 ./helm-chart -f tenants/user4.values.yaml`. No cluster restart.

Proof: `01-tenants-overview.png`, `02-all-user-resources.png`, `05-ingress-installed.png`, `06-ingress-certs.png`, `07-https-tenants.png`, `08-dynamic-onboarding.png`.

### 2. CI/CD pipeline
GitHub Actions workflow in `.github/workflows/deploy.yml`:
1. Build & push image to GHCR
2. Helm lint + render manifests for each tenant
3. Simulated deploy step
4. Rollback job (manual trigger only)
5. Publishes a `DeploymentSucceeded` event to Kafka

Proof: `17-ci-cd-pipeline.png` (successful run), `04-rollback.png` (helm rollback output).

### 3. Scaling & observability
- HPA per tenant: 2 to 6 replicas, target 50% CPU.
- ResourceQuota per namespace: 1 CPU / 1Gi requests, 2 CPU / 2Gi limits, 10 pods max.
- PodDisruptionBudget: `minAvailable: 1`.
- Load generated with `hey` against `/burn` (a CPU-burn endpoint on the app).

Proof: `10-probes-resources.png`, `11-pdb-and-netpol.png`, `12-hpa-baseline.png`, `13-hpa-scaling-up.png`, `14-hpa-scaling-down.png`, `15-grafana-dashboard.png`.

### 4. Kafka event-driven pipeline
- Single-node Kafka (KRaft mode) running in-cluster via `kafka/kafka.yaml`.
- App publishes a `WebsiteCreated` event on startup (see `app/server.js`).
- Consume:

```bash
kubectl exec -n kafka kafka-0 -- /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka.kafka.svc.cluster.local:9092 \
  --topic website-events --partition 0 --offset earliest \
  --max-messages 20 --timeout-ms 10000
```

Proof: `16-kafka-events.png`.

## Notes / trade-offs

- **NetworkPolicy + Kafka.** The default-deny policy blocks egress to the Kafka namespace. For the Kafka demo this was temporarily relaxed on user1 by deleting `user1-default-deny`, then restored via `helm upgrade`. Production fix: add an explicit egress rule allowing `kafka.kafka:9092` to the chart's NetworkPolicy template.
- **TLS.** Used cert-manager's self-signed ClusterIssuer because the cluster is local. Swap `clusterIssuer: selfsigned-issuer` to `letsencrypt-prod` for real domains.
- **Kafka.** Single node, no replication. Sufficient for the demo; in production it would be a 3-broker StatefulSet with PVCs and proper `min.insync.replicas`.
- **CI/CD deploy step is simulated.** The workflow lints and renders manifests but doesn't push to the local kind cluster (no inbound network from GitHub). Wiring it to a real cluster is a kubeconfig secret + one `helm upgrade` line.

## Rollback

```bash
helm history user1
helm rollback user1 <revision>
```

## Tear down

```bash
kind delete cluster --name platform
```
