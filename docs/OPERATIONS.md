# Operations: availability, backup, security

Targets from the proposal: **99.9 %+ uptime** for clinical-critical services, **RTO ≤ 30 min,
RPO ≤ 5 min**, daily off-site backup, AES-256 at rest and in transit, full audit, offline
fallback.

## Topology (1,000 beds)

| Tier | Recommended | Notes |
|---|---|---|
| Load balancer / TLS | 2 × nginx or cloud LB, TLS 1.2+ | terminate TLS, HSTS, forward `X-Forwarded-*` (`--proxy-headers` is on) |
| API | ≥ 3 containers × 4 uvicorn workers | stateless; scale horizontally; sticky sessions not needed |
| Worker | 2 × `arq app.worker.WorkerSettings` | notifications, nightly room/nursing charges, reminders, credential alerts |
| PostgreSQL 16 | primary + synchronous standby (Patroni / RDS Multi-AZ / Azure Flexible HA) + async read replica for analytics | `max_connections` ≥ (API containers × 40) |
| Redis 7 | Sentinel or managed (ElastiCache / Azure Cache) with AOF | cache, pub/sub, OTPs, rate limits, job queue — data is reconstructable |
| Object storage | S3 / Azure Blob for `UPLOAD_DIR` (mount or sync) | patient documents, consents, scans |

Size `[X] concurrent users` during discovery; start with 1 API container per ~250 active users.

## Backups (RPO ≤ 5 min, RTO ≤ 30 min)

* Continuous WAL archiving with **pgBackRest** (or the managed service's PITR) — `archive_timeout = 60`
  gives a worst-case loss of about a minute; keep 14 days of PITR.
* Nightly full backup + daily **off-site copy** (separate region/account, immutable bucket).
* `scripts/backup.sh` — logical dump for small installs / extra safety (`pg_dump -Fc`), encrypted
  with a KMS/age key before leaving the server.
* Restore drill monthly: provision → `pgbackrest restore --type=time` → start API → smoke test
  (`/api/health`, sign-in, open a patient). Record the time; it must stay under 30 minutes.
* Uploads: versioned object storage with lifecycle rules.

## Security

* **In transit:** TLS everywhere (LB → API can be mTLS inside the VPC); PostgreSQL `sslmode=require`.
* **At rest:** encrypted volumes / managed-disk encryption (AES-256) for PostgreSQL, Redis and
  uploads; KMS-managed keys; encrypted backups.
* **Application:** Argon2id passwords, short-lived JWTs (`TOKEN_TTL_HOURS`), Redis revocation on
  sign-out, login rate limiting, role- and attribute-based access, audited break-the-glass for
  restricted records, masked national ID numbers, audit trail of every create / edit / status
  change / print / export / sign-in / file view.
* **Secrets:** `JWT_SECRET` (≥ 32 random bytes), DB and gateway credentials from a secret manager —
  never in the image. The app refuses to start in production with the development secret.
* **DPDP Act 2023:** purpose-limited data in AI prompts (de-identified), consent capture
  (Data Processing consent template), retention via `aigov.policies.retention_days`, data
  principal requests handled through MRD.

## Downtime mode

The web app registers a service worker in production builds. When the network or API is
unreachable it serves the app shell and the last read-only API responses (≤ 12 h old) and
shows a banner; saving is blocked with a clear message. Cached data is cleared on sign-out.
Keep paper downtime forms (registration, MAR, orders) and enter them afterwards.

## Monitoring

* `/api/health` (DB + Redis + module count) for the load balancer and uptime checks.
* Ship JSON logs to the SIEM; alert on 5xx rate, p95 latency > 800 ms, DB replication lag,
  Redis memory, worker queue depth, failed notifications, failed logins spikes, break-glass events.
* PostgreSQL: `pg_stat_statements`, autovacuum, bloat on `records` / `audit_log`.

## Upgrades

`AUTO_MIGRATE=true` runs Alembic on start for single-node installs. For multi-node
production set it to `false` and run `alembic upgrade head` as a one-off job before rolling
the API containers. Module definition changes need no migration (fields live in JSONB).
