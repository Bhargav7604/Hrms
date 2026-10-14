# Vlack HRMS — Hospital Information & Management System

A full hospital platform for a 1,000-bed multispecialty hospital, built from the
*Hospital HRMS – Development Proposal*: **80 modules** in 4 core suites plus specialty and
HR & Payroll extensions, on **one patient identity, one order-to-result flow, one billing
engine and one audit trail**.

| | |
|---|---|
| Web | React 19 · TypeScript 7 · Vite 8 · TanStack Query 5 · React Router 8 · Tailwind CSS 4 · Recharts |
| API | Python 3.13 · FastAPI · SQLAlchemy 2 (async) · Alembic · Pydantic 2 |
| Data | PostgreSQL 16 (JSONB + trigram search) · Redis (cache, realtime pub/sub, OTP, rate limits, token revocation, arq job queue) |
| Standards | HL7 v2 · FHIR R4 · ABDM (ABHA) · ICD-10 · DPDP Act 2023 aligned |

## Quick start (development)

```bash
scripts/devinfra.sh start          # PostgreSQL :5432 + Redis :6379 without Docker (first run installs them)
cd backend
uv sync                            # Python 3.13 deps
cp .env.example .env
uv run python -m app.seed          # masters + 2 weeks of realistic demo activity (~40 s)
uv run uvicorn app.main:app --reload --timeout-graceful-shutdown 2
uv run arq app.worker.WorkerSettings   # background jobs: notifications, nightly charges, alerts
cd ../web && npm install && npm run dev  # http://localhost:5173
```

Demo accounts (one per role: admin, ceo, dr.rao, nurse.priya, frontdesk, billing, pharmacy,
lab, radiology, hr, stores, quality, support, marketing, employee) and their development
password are listed in `backend/.env.example`. Change them before any real use.

With Docker: `JWT_SECRET=<long random> docker compose up -d --build`, then
`docker compose exec api python -m app.seed --no-demo` and open http://localhost:8000.

Public screens (no login): patient portal `/portal`, QR pre-registration `/pre-register`,
queue TV display `/display/queue?queues=REG,BILL`.

## How it is built

```
backend/app/
  modules/<suite>/<id>.py   80 module definitions (records, fields, workflows, KPIs, charges, access)
  core/                     generic record engine, registry/spec, auth (JWT + Argon2), RBAC + break-glass, audit, hooks
  engines/                  business rules + purpose-built APIs (billing, MPI, ADT, CPOE, pharmacy, payroll, AI, FHIR…)
  api/                      auth, metadata, generic REST (/api/m/<module>/<entity>), lookups, files, realtime SSE
  seed/                     masters for a 1,000-bed hospital + demo activity
web/src/
  components/               design system, field inputs for every field type, generic list/form/drawer
  pages/bespoke/<key>.tsx   purpose-built workspaces (bed board, billing desk, CPOE, roster, payroll, AI console…)
  portal/                   patient portal (mobile-first)
docs/                       MODULE-SPEC.md (how to add/extend a module), ENGINES-AND-PAGES.md
```

* **Every module is data.** A module file declares its record types, fields (25 types incl.
  signature, file, line items and references), statuses and transitions, KPIs, roles and
  charge capture. The generic engine provides storage, validation, numbering
  (e.g. `UH00000042`, `APT-000123`), REST API, list/search/filter/export, forms, detail drawer,
  workflow buttons, print, audit and realtime refresh — so changes to a module need no code.
* **Engines** add what metadata cannot: duplicate detection and merge, slot booking and
  queues, bed allocation and discharge clearance, CPOE with critical-result alerts, charge
  capture and billing with approval-gated discounts/refunds, FEFO stock and drug-safety checks,
  rosters and statutory payroll (PF/ESI/PT/TDS), AI drafting with mandatory human review,
  FHIR/HL7/ABDM/Tally connectors and statutory registers.
* **Security:** role-based access per module/record type, read-only management access,
  restricted records (psychiatry notes, POSH) with audited break-the-glass, Argon2 passwords,
  short-lived JWTs with Redis revocation and login rate limiting, ID numbers stored masked,
  full audit trail of every create/edit/status change/print/export/sign-in.
* **Realtime:** each committed change is published on Redis and streamed to browsers (SSE);
  lists, boards and dashboards refresh themselves.

## Quality checks

```bash
cd backend && uv run python -m app.tools.check_modules   # validates all 80 module definitions
cd backend && uv run pytest -q                            # API tests (uses database vlack_hrms_test)
cd backend && uv run ruff check app
cd web && npx tsc -b --noEmit
```

## Not included

Hardware, network, third-party licences (PACS, SMS/WhatsApp gateways, cloud hosting) and
legacy data entry are out of scope per the proposal. Gateways run in log/sandbox mode until
credentials are configured (see `engines/notify.py`, `engines/integrations.py`). The Flutter
mobile apps from the proposal are not part of this repository; the web app is responsive
and the patient portal and command center are built mobile-first.
