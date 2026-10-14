# Engines (backend) and workspaces (frontend)

Generic CRUD for all 330 record types comes from the module definitions (see MODULE-SPEC.md).
Business rules and the purpose-built screens live in two places:

| Layer | Where | Registered by |
|---|---|---|
| Engine (rules, hooks, endpoints) | `backend/app/engines/<name>.py` | auto-imported at startup (`app.main.load_engines`) |
| Workspace screen | `web/src/pages/bespoke/<page-key>.tsx` | file name = the `pages[].key` in the module definition |

## Backend engine conventions

```python
from fastapi import APIRouter
from ..core.hooks import hook, listen, emit
from ..core.security import CtxDep, PublicCtxDep, PatientCtxDep
from ._common import E, find, first, get, create, update, transition, count, live, require_role

router = APIRouter(prefix="/api/<area>", tags=["<area>"])     # mounted automatically
public_router = APIRouter(prefix="/api/public/<area>")         # no auth (displays, kiosks)

@hook("ipd.admissions", "before_create")                       # runs inside the request transaction
async def check_bed(ctx, draft): ...                           # raise ApiError to abort

@router.get("/board")
async def board(ctx: CtxDep): ...                              # ctx.conn, ctx.user, ctx.role
```

* `ctx` = one DB transaction per request, committed before the response. Never open another.
* Use `_common` helpers (`find/get/create/update/transition`) — they go through the generic
  record service, so numbering, validation, audit trail, charge capture and realtime events all
  happen. `create/update` are *trusted*: they may set readonly fields and extra data keys.
* Raw SQL is fine for aggregates: tables are in `app/schema.py` (`records` holds every
  non-core entity: filter `records.c.module == "x", records.c.entity == "y"`, fields in `data` JSONB).
* Access: `rs.ensure_access(ctx, E("module.entity"), "read"|"write")` or `require_role(ctx, ...)`.
* Realtime: `live(ctx, "queue" | "beds" | "alerts" | "approvals", payload)` publishes after commit.
  Every record change already publishes on `changes`.
* Domain events: `await emit("order.verified", ctx, {...})`; listeners use `@listen("order.verified")`.
  Events in use: patient.registered, appointment.booked, appointment.checked_in, order.verified,
  order.critical, bill.created, payment.received, discharge.done, otp.requested, queue.called.
* Approvals: `from .workflow import request_approval, on_decided`.
* Charges: `from .billing import post_charge` (or declare `charge` on the entity).
* Background jobs: an engine may define `CRON = [(async_fn, {"hour": 0, "minute": 5})]`;
  `app/worker.py` (arq) collects them. Functions receive an arq ctx; use `app.db.system_ctx()`.
* Money: `Decimal`/`money()` from `core.util`; dates via `core.util.now()/today()` (hospital TZ).

## Frontend workspace conventions

```tsx
import type { BespokeProps } from './index'
export default function BedBoard({ module }: BespokeProps) { ... }
```

* Data: TanStack Query + `api/get/post/put` from `@/lib/api`. Query keys MUST start with
  `['x', '<module id>', ...]` for engine endpoints so realtime change events refresh them
  (`['m', module, ...]` is used by generic lists, `['patient', id]` by patient views,
  `['dash', ...]` by dashboards).
* Building blocks: `@/components/ui` (Button, Card, Badge, StatusBadge, StatTile, Modal, Drawer,
  Tabs, Segmented, Input, Select, Textarea, FieldWrap, KeyValue, Empty, Spinner, ErrorBox, Avatar),
  `@/components/fields` (FieldInput, FieldValue, RefPicker — a searchable picker for any entity),
  `@/components/records` (EntityView — full list with filters/drawer/forms for any entity,
  RecordDrawer, RecordFormModal, NewButton, TransitionDialog, useEntity, useMyEmployeeId),
  `@/lib/format` (money, moneyShort, date, dateTime, time, ago, age, minutes, number),
  `@/lib/auth` (useAuth, useRegistry → canPage/canEntity/entity(fqn)), `@/lib/icons` (Icon by name).
* Toasts: `import { toast } from 'sonner'`; show `errorMessage(e)` from `@/lib/api` on failure.
* Styling: Tailwind v4 with the semantic tokens in `src/index.css` — `bg-surface`, `bg-surface-2`,
  `bg-plane`, `text-ink`, `text-ink-2`, `text-ink-3`, `border-line`, `border-line-2`, brand
  `brand-50…950`. Light and dark both work through these tokens; avoid raw grays for surfaces/text.
  Status colour always comes with a text label (`StatusBadge`).
* Charts: Recharts, colours `var(--s1)…var(--s6)` (validated categorical order), one axis only,
  tooltips on, legends for ≥ 2 series, gridlines `var(--grid)`.
* Patients link to `/patients/<id>` (the 360° view). Records open in place with
  `?r=<id>` on any EntityView.
* Layout: pages render inside the module page (header + KPI strip + tabs already present).
  Keep within the content width; must work on a 1280px laptop and stay usable on a tablet.
