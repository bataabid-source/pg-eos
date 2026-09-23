# PG-EOS — Oracle Cloud Infrastructure Deployment (Tier 0)
**Document 42 · Version 4.1 · 23 September 2026**

> **v4 — Document status:** Governing · **Governs on conflict:** 40, 36, EXECUTION-MASTER-v4 · **Corrections applied in v4:** GOV-02, GOV-11, GOV-33, GOV-37, GOV-38, PLT-17, PLT-18, PLT-19, PLT-22, PLT-42 · **Previously open decisions:** closed in EXECUTION-MASTER-v4 §1.

**Scope:** Deployment target for Phases 0–3. Architecture (doc 36) unchanged.
**Constraint:** Oracle **Always Free** resources only. No paid resources without explicit GM instruction.
**Security posture (recorded, §11 #3):** **zero inbound ports on the VM.** Everything below is written on that basis — there is no variant of §2–§5 that opens 22, 80 or 443. The Origin-Certificate variant is retained only in Appendix A and is not to be executed without a written GM decision.

---

## 0. Positioning

| Tier | Target | Phases | Trigger to move up |
|---|---|---|---|
| **0** | **Oracle Always Free** — 1× A1.Flex (**4 OCPU / 24 GB**, the whole Always Free ARM quota in one VM) · Docker Compose · Cloudflare Tunnel | 0 – 3 | Before Phase 4 (Finance) **or** p95 SLO breach for 7 consecutive days **or** > 40 concurrent users |
| 1 | **Paid OCI resources on the same PAYG account** — PostgreSQL split into its own VM + a read replica; WAL archiving and managed backups. Size decided at the trigger; **no paid resource without a written GM instruction** | 4 – 6 | HA requirement · reporting load |
| 2 | Google Cloud `me-central1` — Cloud Run + Cloud SQL (doc 36 §2-4) | Scale | Multi-region / read replica beyond one region |
| — | Premium Group local server | Sovereignty | Legal requirement |

Tier 1 is **not** defined by core count: the Always Free ARM quota is already 4 OCPU / 24 GB and is used in full at Tier 0. What Tier 1 buys is **WAL archiving, managed backups, a separate database VM and a read replica** — that is, RPO and reporting isolation, not CPU.

**Portability guarantee:** the same `docker-compose.yml` runs on any tier. Moving = copy compose + `.env` + restore backup + repoint DNS.

### Honest constraints of Tier 0

| Constraint | Consequence | Mitigation |
|---|---|---|
| Idle reclamation on Free accounts (< 20% CPU over 7 days) | Instance deleted | ✅ **Already done — PAYG upgrade recorded 20 Sep (§11 #1)**; free resources stay free and reclamation stops |
| A1.Flex capacity shortages | Provisioning fails for days | Retry script (§2.4) or the recorded fallback region (§11 #2) |
| Single VM, no HA | RTO measured in hours | Daily off-VM backups; documented rebuild ≤ 2 h |
| Self-managed PostgreSQL | Backups, upgrades, tuning are ours | Scripts in §6; monthly restore test |
| ARM64 | All images must be `linux/arm64` | Node, Postgres, Nginx, Chromium all available |
| Nearest regions: Jeddah, Dubai, Abu Dhabi — no Kuwait | ~20–40 ms latency | Acceptable |
| No read replica at Tier 0 | The 24 reports read the primary | `statement_timeout` + off-peak schedule for the heavy reports; the read-replica requirement (doc 40 §B6, doc 36 §4-4) activates at Tier 1 |

---

## 1. Oracle Cloud — Tenancy Setup

| # | Step | Detail | Who |
|---|---|---|---|
| 1.1 | Create account | Oracle Cloud · company email `cloud@premiumgrp.co` · **Home region: Saudi Arabia West — Jeddah (`me-jeddah-1`)**; fallback UAE East — Dubai (`me-dubai-1`) **only on capacity failure** (§11 #2) | GM |
| 1.2 | Enable MFA on the root user | Security → MFA | GM |
| 1.3 | Compartment | `premium-production` (child of root) | GM / agent |
| 1.4 | IAM group + user for automation | Group `premium-admins` · user `deployer` · API key stored in the VM's secrets, never in repo | GM |
| 1.5 | Tenancy type — PAYG | ✅ **RECORDED 20 Sep (§11 #1)** — prevents reclamation; still $0 within Always Free; budget alert at $1; no paid resource without a written GM instruction | Done |

---

## 2. Network & Compute

### 2.1 VCN

```
VCN  premium-vcn        10.0.0.0/16
  ├─ Internet Gateway   igw-premium        (egress only — no ingress route is used)
  ├─ Public subnet      10.0.1.0/24        (VM)
  └─ Route table        0.0.0.0/0 → igw-premium
```

### 2.2 Network Security Group `nsg-web` — **no ingress rules**

| Direction | Protocol | Port | Source / Destination | Note |
|---|---|---|---|---|
| Ingress | — | **none** | — | **The NSG has no ingress rule at all.** All traffic reaches the VM through the Cloudflare Tunnel, which is an outbound connection established by `cloudflared` |
| Egress | all | all | 0.0.0.0/0 | updates, Cloudflare, backups |

**Never open:** 22 (SSH — use the tunnel's `ssh` hostname, §5.3), 80 and 443 (HTTP/HTTPS — terminated at Cloudflare), 5432 (Postgres), 6379 (Redis), 3000/4000 (app internals).

### 2.3 Compute instance

| Setting | Value |
|---|---|
| Shape | `VM.Standard.A1.Flex` · **4 OCPU · 24 GB** (the full Always Free ARM quota) |
| Image | Ubuntu 24.04 LTS (aarch64) |
| Boot volume | **200 GB** (the full Always Free block-storage quota) |
| Public IP | **Reserved** (static) — held for portability; no inbound listener is bound to it |
| SSH | Key pair generated locally; **password login disabled**; reachable only through the Cloudflare Tunnel `ssh` hostname |
| NSG | `nsg-web` (egress only) |
| Name | `pg-eos-t0` |

### 2.4 Capacity retry (if "Out of host capacity")

```bash
# retry every 10 minutes until the instance is created
while ! oci compute instance launch --from-json file://instance.json 2>/dev/null; do
  sleep 600
done
```

If capacity in `me-jeddah-1` fails for more than 48 hours, switch to the recorded fallback `me-dubai-1` (§11 #2). No other region is approved.

---

## 3. Ubuntu Hardening

```bash
# 3.1 updates + unattended security updates
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y unattended-upgrades fail2ban ufw git curl
sudo dpkg-reconfigure -plow unattended-upgrades

# 3.2 SSH: keys only, no root. The daemon listens on loopback only — it is reached
#     exclusively through the Cloudflare Tunnel 'ssh' hostname (§5.3).
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?ListenAddress.*/ListenAddress 127.0.0.1/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# 3.3 firewall — deny all incoming, no allow rules at all.
#     cloudflared makes an OUTBOUND connection, so nothing needs to be opened.
sudo iptables -F && sudo netfilter-persistent save
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw enable
sudo ufw status verbose        # expected: "Default: deny (incoming)" with an empty rule list

# 3.4 fail2ban for sshd (default jail is enough; SSH is behind the tunnel but the jail stays)
sudo systemctl enable --now fail2ban

# 3.5 deploy user
sudo adduser --disabled-password deploy
sudo usermod -aG docker deploy   # after Docker install
```

**Before the tunnel exists**, the instance is reached through the OCI console's serial/Cloud-Shell session — not by opening 22. The tunnel is installed in the same first session (§5.3).

---

## 4. Docker Environment

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo apt install -y docker-compose-plugin
sudo mkdir -p /opt/premium && sudo chown deploy:deploy /opt/premium
```

### 4.1 Layout on the server

```
/opt/premium/
├── docker-compose.yml
├── .env                       ← never in git · chmod 600
├── nginx/
│   └── nginx.conf             ← plain HTTP on port 80 inside the compose network
├── cloudflared/
│   └── config.yml             ← tunnel ingress rules (§5.3)
├── data/
│   ├── postgres/              ← persistent volume
│   ├── uploads/               ← documents, photos
│   └── backups/               ← local staging before off-VM upload
├── scripts/
│   ├── backup.sh
│   ├── restore.sh
│   ├── deploy.sh
│   └── healthcheck.sh
└── repo/                      ← git clone of pg-eos (read-only on server)
```

There is no `nginx/certs/` directory at Tier 0: TLS terminates at Cloudflare and origin traffic runs inside the tunnel.

### 4.2 `docker-compose.yml` (Tier 0)

```yaml
name: premium
services:
  postgres:
    image: postgres:16-alpine
    platform: linux/arm64
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${PG_DB}
      POSTGRES_USER: ${PG_USER}
      POSTGRES_PASSWORD: ${PG_PASSWORD}
      # SCR-TRGM-01 (GM 2026-09-23, option A): ctype C.UTF-8 so pg_trgm sees Arabic letters; collation C.
      # --locale=C for every category, then LC_CTYPE C.UTF-8 only (GM approved ctype only)
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C --lc-ctype=C.UTF-8"
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${PG_USER} -d ${PG_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
    shm_size: 256m
    # NO ports: — internal network only

  api:
    build: { context: ./repo, dockerfile: apps/api/Dockerfile, platforms: [linux/arm64] }
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgres://${PG_USER}:${PG_PASSWORD}@postgres:5432/${PG_DB}
      NODE_ENV: production
    depends_on:
      postgres: { condition: service_healthy }
    volumes:
      - ./data/uploads:/app/uploads
    networks: [internal]
    # NO ports: — reached through nginx only
    # pg-boss workers run inside the api process (Tier 0); split to a 'worker' service at Tier 1

  admin:
    build: { context: ./repo, dockerfile: apps/admin/Dockerfile, platforms: [linux/arm64] }
    restart: unless-stopped
    networks: [internal]
    # NO ports:

  portal:
    build: { context: ./repo, dockerfile: apps/portal/Dockerfile, platforms: [linux/arm64] }
    restart: unless-stopped
    networks: [internal]
    # NO ports:

  nginx:
    image: nginx:1.27-alpine
    platform: linux/arm64
    restart: unless-stopped
    # Loopback binding ONLY — nothing is published to the public interface.
    # cloudflared (a host systemd service) connects to http://127.0.0.1:8080.
    ports: ["127.0.0.1:8080:80"]
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on: [api, admin, portal]
    networks: [internal]

  # Redis is NOT included: the architecture uses pg-boss (Postgres) for queues and
  # Postgres-backed sessions. Add only if a later requirement is documented.

networks:
  internal:
    driver: bridge
```

**Database locale (v4.1 · SCR-TRGM-01, GM 2026-09-23).** Every PG-EOS database is created with encoding UTF8, `lc_collate = C`, `lc_ctype = C.UTF-8`. Under `lc_ctype = C` pg_trgm keeps no Arabic letter and `similarity()` of two identical Arabic names is 0, so the duplicate detection of doc 40 §C2 INV-C2-3 never fires on `name_ar`. `POSTGRES_INITDB_ARGS` only applies when `./data/postgres` is empty; on an already-initialised volume the image default (`LANG en_US.utf8`) stays, so the volume is re-initialised — or the database is recreated from `template0` with the locale above — before the first `apply.sh`. `database/schema/apply.sh` creates the database with these settings on `--recreate` and refuses any database created otherwise.

**Behaviour check, not a name check (WBS 0.5 at provisioning, WBS 0.8 at every restore).** This image is Alpine (musl); musl accepts any locale name, so `datctype = 'C.UTF-8'` proves nothing by itself. Run on the Tier-0 database: `show_trgm('مخزن')` is not empty; `similarity('اختبار','اختبار') = 1`; the boundary pair `اختبارمكررتجريبي` / `اختبارمكررتجريبي كو` gives `similarity()::numeric(10,6) = 0.850000`; and the sales proof suite and the platform environment test pass in full against it. A failure is a deployment blocker.

**Check after `up -d`:** `ss -ltnp` must show the only listeners as `127.0.0.1:8080` (nginx) and `127.0.0.1:22` (sshd). Anything bound to `0.0.0.0` is a defect.

### 4.3 `.env` (template — real values never committed)

```
PG_DB=pgeos
PG_USER=pgeos
PG_PASSWORD=<32+ random chars>
JWT_SECRET=<64 random chars>
OTP_EMAIL_FROM=noreply@premiumgrp.co
SMTP_URL=<workspace smtp relay>
BACKUP_BUCKET=pg-eos-backups
OCI_NAMESPACE=<tenancy namespace>
```

---

## 5. Domain, DNS, Tunnel

### 5.1 Cloudflare DNS (`premiumgrp.co`)

All records are **tunnel CNAMEs** (`<tunnel-id>.cfargotunnel.com`), created by `cloudflared tunnel route dns`. No record points at the VM's IP.

| Record | Type | Target | Proxy | Serves |
|---|---|---|---|---|
| `app` | CNAME | tunnel | ✅ proxied | Admin application |
| `api` | CNAME | tunnel | ✅ proxied | API |
| `portal` | CNAME | tunnel | ✅ proxied | Client portal |
| `apps` | CNAME | tunnel | ✅ proxied | Application distribution page (`premium-apps-download.html`) and the PDA PWA install route |
| `ssh` | CNAME | tunnel | ✅ proxied | SSH over the tunnel, gated by Cloudflare Access (§5.3) |

Records are documented in `docs/dns.md` (§9).

### 5.2 TLS — recorded decision

TLS terminates at Cloudflare (**Full (strict)** is not required at Tier 0 because the origin leg runs inside the tunnel, not over the public Internet). Nginx serves plain HTTP on the loopback; the tunnel is the only path in. The Origin-Certificate variant is **Appendix A** and is not executed without a written GM decision.

### 5.3 Cloudflare Tunnel — the implemented path

```bash
# on the VM (install in the first console session, before anything else is exposed)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
     -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
cloudflared tunnel login
cloudflared tunnel create pg-eos-t0

# route every hostname to the tunnel
for h in app api portal apps ssh; do
  cloudflared tunnel route dns pg-eos-t0 "$h.premiumgrp.co"
done

# /opt/premium/cloudflared/config.yml
cat <<'YML' | sudo tee /etc/cloudflared/config.yml
tunnel: pg-eos-t0
credentials-file: /etc/cloudflared/pg-eos-t0.json
ingress:
  - hostname: api.premiumgrp.co
    service: http://127.0.0.1:8080
  - hostname: app.premiumgrp.co
    service: http://127.0.0.1:8080
  - hostname: portal.premiumgrp.co
    service: http://127.0.0.1:8080
  - hostname: apps.premiumgrp.co
    service: http://127.0.0.1:8080
  - hostname: ssh.premiumgrp.co
    service: ssh://127.0.0.1:22
  - service: http_status:404
YML

sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

- **Zero inbound ports** — the NSG has no ingress rule and `ufw` has no allow rule (§2.2, §3.3). `cloudflared` dials out.
- **SSH** goes to `ssh.premiumgrp.co` through `cloudflared access ssh --hostname ssh.premiumgrp.co`, protected by a **Cloudflare Access** policy limited to the GM and the deputy system owner. A bastion host is the documented alternative; the Tunnel is the chosen option because §11 #3 already records it, and a second path would be a second attack surface.
- Origin IP is never exposed; DDoS and WAF are handled at the edge.

### 5.4 `nginx/nginx.conf` (core — HTTP only, behind the tunnel)

```nginx
worker_processes auto;
events { worker_connections 1024; }
http {
  include mime.types;
  sendfile on; gzip on;
  client_max_body_size 25m;                 # photo uploads (watermarked, ≤ 300 KB each)
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }

  # No HTTP→HTTPS redirect and no TLS blocks: TLS terminates at Cloudflare and the
  # origin leg runs inside the tunnel. Routing is by server_name on port 80 only.

  server {
    listen 80;
    server_name api.premiumgrp.co;
    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    location / {
      proxy_pass http://api:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $http_cf_connecting_ip;
      proxy_set_header X-Forwarded-Proto https;   # the public leg is always HTTPS
      proxy_read_timeout 60s;
    }
  }

  server {
    listen 80;
    server_name app.premiumgrp.co;
    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; style-src 'self' https://fonts.googleapis.com" always;
    location / { proxy_pass http://admin:80; }
  }

  server {
    listen 80;
    server_name portal.premiumgrp.co;
    location / { proxy_pass http://portal:80; }
  }

  server {
    listen 80;
    server_name apps.premiumgrp.co;
    location / { proxy_pass http://admin:80; }     # serves the distribution page and the PDA PWA
  }

  server { listen 80 default_server; server_name _; return 444; }   # unknown host: drop
}
```

---

## 6. Backups & Disaster Recovery

### 6.1 Policy — Tier 0 re-baselined (doc 40 Part G carries both tiers)

| Data | Frequency | Retention (Tier 0) | Retention (Tier 1/2) | Location |
|---|---|---|---|---|
| PostgreSQL (`pg_dump -Fc`) | daily 02:00 | **14 daily · 8 weekly · 6 monthly** | 30 daily · 12 weekly · 12 monthly | **OCI Object Storage** (Always Free 20 GB) — off-VM |
| `data/uploads` | daily 02:30 | same | same | same |
| `.env`, `nginx/`, `cloudflared/`, `docker-compose.yml` | on change | 10 versions | 10 versions | same, encrypted |

The Tier 0 figures are driven by the 20 GB Always Free Object Storage quota; they return to 30/12/12 at Tier 1. A **monthly restore test** is required at both tiers.

### 6.2 `scripts/backup.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/premium && source .env
TS=$(date +%Y%m%d-%H%M)
DAY=$(date +%u); DOM=$(date +%d)
mkdir -p data/backups

docker compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "data/backups/db-$TS.dump"
tar -czf "data/backups/uploads-$TS.tgz" -C data uploads

# tiering: daily always; weekly on Sunday; monthly on the 1st
TIER=daily; [ "$DAY" = 7 ] && TIER=weekly; [ "$DOM" = 01 ] && TIER=monthly
for f in "data/backups/db-$TS.dump" "data/backups/uploads-$TS.tgz"; do
  oci os object put --bucket-name "$BACKUP_BUCKET" --namespace "$OCI_NAMESPACE" \
      --name "$TIER/$(basename "$f")" --file "$f" --force
done
# local staging: keep 3 days only
find data/backups -type f -mtime +3 -delete
```

Object Storage **lifecycle rules** enforce retention: `daily/` 14 d · `weekly/` 56 d · `monthly/` 180 d — i.e. 14 · 8 · 6.

### 6.3 `scripts/restore.sh` (tested monthly — WBS 0.8)

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/premium && source .env
DUMP=$1   # path to db-*.dump
docker compose stop api
trap 'docker compose start api' EXIT   # the API restarts on every exit path, including a failed check below
docker compose exec -T postgres dropdb -U "$PG_USER" --if-exists "${PG_DB}_restore"
docker compose exec -T postgres createdb -U "$PG_USER" -T template0 -E UTF8 --lc-collate=C --lc-ctype=C.UTF-8 "${PG_DB}_restore"   # SCR-TRGM-01
docker compose exec -T postgres pg_restore -U "$PG_USER" -d "${PG_DB}_restore" < "$DUMP"
# verify guard functions on the restored DB before swapping
docker compose exec -T postgres psql -U "$PG_USER" -d "${PG_DB}_restore" \
  -c "select count(*) from wms.verify_balance_integrity();" \
  -c "select count(*) from billing.verify_journal_balance();"
# SCR-TRGM-01: a restore with the wrong locale passes the checks above silently — verify locale and Arabic trigrams too
LOC=$(docker compose exec -T postgres psql -U "$PG_USER" -d "${PG_DB}_restore" -Atc   "select datctype || '|' || datcollate || '|' || (cardinality(show_trgm('مخزن')) > 0) from pg_database where datname = current_database()")
[ "$LOC" = "C.UTF-8|C|true" ] || { echo "restore locale check failed: $LOC (expected C.UTF-8|C|true)"; exit 1; }
echo "Restored to ${PG_DB}_restore. Swap manually after verification."
```

### 6.4 Tier 0 recovery objectives

| Objective | **Tier 0** (single VM, Phases 0–3) | **Target (doc 40 Part G · doc 36 §7)** — Tier 1/2 | Note |
|---|---|---|---|
| RPO | **≤ 24 h** (daily dump) | ≤ 1 h | WAL archiving added at Tier 1 |
| RTO | **≤ 4 h** (rebuild VM + restore) | ≤ 4 h | Rebuild script in §9 |
| Availability, business hours | ≥ 99.5% | ≥ 99.5% | doc 40 Part G |

The RPO/RTO targets belong to **doc 40 Part G and doc 36 §7**; doc 25 states the availability targets and does not state RPO/RTO. The Tier 0 figures are re-baselined for Phases 0–3 only and must return to the Tier 1/2 targets before Phase 4 (EXECUTION-MASTER-v4 §1.4).

---

## 7. Monitoring (Tier 0 — lightweight)

| Concern | Tool | Alert |
|---|---|---|
| CPU · RAM · disk · containers | **Netdata** (arm64, single container) or `node_exporter` + Grafana Cloud free | disk > 80% · container restart loop |
| PostgreSQL | `postgres_exporter` | connections > 80% · replication n/a |
| Availability | **Uptime Kuma** (self-hosted) or Cloudflare Health Checks | `/health` fails 3× |
| Tunnel | `cloudflared` systemd unit + Cloudflare tunnel health | tunnel down > 2 min |
| Application | pino JSON → `docker logs` → Loki (Tier 1) | 5xx > 1% |
| Backups | `backup.sh` exit code → healthcheck ping | missed run |

The SSL row of v1 is gone: there is no origin certificate to expire at Tier 0. Alerts → WhatsApp/email to GM and deputy.

---

## 8. Repository Mapping

The proposed flat layout (`frontend/ backend/ database/`) **would break the modular-monolith boundary enforcement** (doc 36 §1-1). Keep the monorepo. The tree is the one in BOOTSTRAP-v4 §7; the infrastructure part of it is:

```
pg-eos/
├── apps/         api · admin · portal · driver · pda · decisions
├── modules/      one package per module (hexagonal) — 15 packages
├── packages/     contracts · db · events · domain-kit · ui · i18n
├── database/
│   ├── schema/           01 · 13 · 13B · 019 as delivered
│   ├── migrations/       numbered, forward-only
│   └── seeds/
├── infra/
│   ├── docker/           docker-compose.yml · Dockerfiles
│   ├── nginx/            nginx.conf
│   ├── cloudflared/      config.yml
│   ├── scripts/          backup.sh · restore.sh · deploy.sh · healthcheck.sh
│   ├── oci/              instance.json · nsg rules · tunnel config
│   └── terraform/        reserved for Tier 2 (GCP)
├── tests/        scenarios · guards · load
└── docs/         package/ · notes/ · dns.md · runbook.md
```

`.gitignore` must include: `.env`, `*.pem`, `*.key`, `data/`, `*.dump`, `*.tgz`, `id_*`.

### 8.1 `scripts/deploy.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/premium/repo && git fetch && git checkout "${1:-main}" && git pull
cd /opt/premium
docker compose build --pull
docker compose run --rm api pnpm db:migrate        # Drizzle migrations (database/migrations)
docker compose up -d
docker compose run --rm api pnpm guards:run        # guard tests G1–G18 (doc 40 Part F)
docker compose run --rm api pnpm test:scenarios    # acceptance scenarios (G15)
./scripts/healthcheck.sh
```

**Guard pass condition:** Guards G1–G18 must each return zero rows **or the stated pass condition** (G13 100 unique · G15 all scenarios pass · G16 ≥ 75% · G17 ≤ 2 s); **G18 (`billing.verify_unpriced_events()`) is report-only and does not block**. A single failure of G1–G17 blocks merge and deploy. G15/G16/G17 are not SQL functions, so `guards:run` alone does not cover them — hence the explicit `test:scenarios` line and the nightly mutation run.

**Rollback:** `git checkout <previous-tag> && ./scripts/deploy.sh` — migrations are forward-only; a failed migration blocks `up -d`.

---

## 9. Migration Readiness — Portability Checklist

| Artifact | Stored in | Verified by |
|---|---|---|
| `docker-compose.yml` | repo `infra/docker/` | rebuild drill |
| `.env` template + real values | repo template · vault for values | — |
| DB backup/restore | `infra/scripts/` | monthly restore test |
| Nginx config | repo `infra/nginx/` | rebuild drill |
| Tunnel config + Access policy | repo `infra/cloudflared/` (credentials excluded) | rebuild drill |
| DNS records | documented in `docs/dns.md` | — |
| Deployment procedure | `docs/runbook.md` §1 | deputy executes unassisted |
| Server setup | this document §2–§5 | **quarterly rebuild drill on a fresh VM** |

**Database locale parity (v4.1 · SCR-TRGM-01).** Development runs `postgres:16` (glibc, `infra/docker/docker-compose.yml`) and Tier 0 runs
`postgres:16-alpine` (musl): Arabic character classification now depends on each libc's Unicode tables, so both are verified by the
behaviour check of §4.2, not assumed equal. Whether to align the two images is a GM decision (flagged 2026-09-23, not decided here).
The Tier-2 managed database must be created with the same encoding / `lc_collate C` / `lc_ctype C.UTF-8` — still to be verified.

**Move procedure (any target):** provision host → install Docker → clone repo → copy `.env` → `restore.sh` latest dump → `deploy.sh` → switch DNS. **Target: ≤ 2 hours.**

---

## 10. Changes to the Package

| Doc | Change |
|---|---|
| 36 §2-4 | Cloud decision is **tiered**: Tier 0 Oracle Always Free (this doc) → Tier 2 Google Cloud unchanged as the scale target |
| 36 §4-4 | Read replica for reporting is a **Tier 1/2** target; at Tier 0 reports run on the primary with `statement_timeout` and an off-peak schedule |
| 38 Phase 0 | 0.3 → Oracle tenancy; 0.5 → Docker Compose + Cloudflare Tunnel (Terraform deferred to Tier 2); 0.7 → Tier 0 monitoring; 0.8 → `backup.sh` with 14/8/6 |
| 40 Part G | RPO/RTO and backup retention carry the tier label: Tier 0 = 24 h / 4 h and 14/8/6; Tier 1/2 = ≤ 1 h / ≤ 4 h and 30/12/12 |
| 41 Part 1 | Oracle steps replace the Google Cloud steps for now; the GCP section is retained for Tier 2. **Part 2 (model routing) is superseded** by EXECUTION-MASTER-v4 Part 4 and BOOTSTRAP-v4 §4 |
| **25 §7** | Availability targets hold (≥ 99.5% business hours); RPO/RTO are **not** stated in doc 25 — doc 40 Part G is their source |
| **26** | Continuity figures updated to the tier table: Tier 0 RPO 24 h / RTO 4 h, retention 14/8/6; Tier 1/2 ≤ 1 h / ≤ 4 h, retention 30/12/12; manual-mode declaration and the first drill as recorded in EXECUTION-MASTER-v4 §1.4 |
| C-tools `premium-apps-download.html` | Its `apps.premiumgrp.co` links are now backed by a DNS record (§5.1) |

---

## 11. Decisions — RECORDED 20 September 2026

| # | Decision | **Recorded value** | Effect |
|---|---|---|---|
| 1 | Tenancy type | **Pay-As-You-Go** | Always Free resources remain $0; idle-instance reclamation is disabled. No paid resource may be provisioned without explicit GM instruction (budget alert at $1). |
| 2 | Home region | **Saudi Arabia West — Jeddah (`me-jeddah-1`)** | Nearest available region to Kuwait. Fallback on capacity failure: UAE East — Dubai (`me-dubai-1`). |
| 3 | Edge/TLS | **Cloudflare Tunnel** | Zero inbound ports on the VM (no 80/443/22). SSH through the tunnel's `ssh` hostname behind Cloudflare Access. Nginx binds to `127.0.0.1:8080` only. |
| 4 | Tier-0 RPO | **24 h accepted for Phases 0–3 only** | WAL archiving added at Tier 1 before Phase 4. |
| 5 | Tier-1 trigger | **Any of:** before Phase 4 · > 40 concurrent users · any p95 SLO breach for 7 consecutive days | Whichever comes first. |

**Where decision #3 is implemented in this document (v4):**
- §2.2 — `nsg-web` has **no ingress rules**; egress only.
- §2.3 — no inbound listener bound to the reserved public IP; SSH via tunnel only.
- §3.2 — `sshd` listens on `127.0.0.1` only.
- §3.3 — `ufw default deny incoming` with **no allow rules**; the verification command and its expected output are given.
- §4.2 — `postgres`, `api`, `admin`, `portal` publish **no ports**; `nginx` binds `127.0.0.1:8080` only; the `ss -ltnp` check states the only two acceptable listeners.
- §5.1 — every DNS record is a tunnel CNAME; no record points at the VM's IP.
- §5.3 — the tunnel, its ingress rules, the `ssh` hostname and the Access policy.
- §5.4 — `nginx.conf` has no `listen 443`, no certificates and no HTTP→HTTPS redirect; unknown hosts get `444`.
- §7 — the origin-certificate expiry monitor is removed; tunnel health is monitored instead.

---

## Appendix A — Origin Certificate (NOT SELECTED)

Retained for the record only. **Do not execute without a written GM decision reversing §11 #3.** Choosing it reintroduces inbound 80/443 and therefore changes the NSG, `ufw`, the compose file and `nginx.conf` together — never one of them alone.

- Cloudflare → SSL/TLS → **Full (strict)**.
- Origin Certificates → create (15 years) → place in `nginx/certs/origin.pem` + `origin.key`.
- Nginx would then serve `listen 443 ssl http2` for `api` / `app` / `portal` / `apps`, with a `listen 80` block redirecting to HTTPS; the `nginx` service would publish `["80:80", "443:443"]`; `nsg-web` would allow ingress 443 and 80 **from Cloudflare IP ranges only**; `ufw` would allow 80/tcp and 443/tcp.
- SSH would then need either the tunnel anyway or a bastion host — it is never opened to the Internet in any variant.
