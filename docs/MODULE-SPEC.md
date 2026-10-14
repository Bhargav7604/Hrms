# Module definition spec

Every one of the 80 proposal modules is a Python file in `backend/app/modules/<suite>/<id>.py`
that exports a plain dict named `MODULE`. The backend validates it (`app/core/spec.py`,
unknown keys are rejected), stores records through one generic engine, and the React
client renders lists, forms, detail drawers, workflows and KPIs from it. Engine-heavy
flows (registration, booking, bed board, CPOE, billing, payroll…) add bespoke pages on top.

Validate after any change:

```bash
cd backend && uv run python -m app.tools.check_modules
```

## Module

```python
MODULE = {
    "no": 65,                       # proposal number (1-80), unique
    "id": "dialysis",               # lowercase a-z0-9, unique, used in URLs: /api/m/dialysis/...
    "suite": "specialty",           # front-office | clinical | operations | governance | specialty | hr
    "name": "Renal / Dialysis",
    "icon": "Droplets",             # lucide-react icon name (PascalCase), https://lucide.dev/icons
    "summary": "One sentence shown under the module title.",
    "features": ["...", "..."],     # the proposal's feature bullets for this module, verbatim-ish
    "roles": ["nurse", "doctor"],   # full read/write access (admin always has access)
    "read_roles": ["billing"],      # read-only access (management can always read)
    "pages": [],                    # bespoke React pages — ONLY keys agreed with the web team
    "entities": [ ... ],
    "kpis": [ ... ],
}
```

Roles: `admin, management, doctor, nurse, front_office, billing, pharmacist, lab, radiology, hr,
stores, quality, support, marketing, employee`.

## Entity

```python
{
    "key": "sessions",              # snake_case, unique within the module
    "label": "Dialysis Sessions",   # plural, shown as the tab title
    "singular": "Session",          # optional (derived from label)
    "prefix": "DYS",                # 2-5 capital letters → codes like DYS-000123 (globally unique)
    "patient": True,                # adds a required patient picker (stored in patient_id column)
                                    #   "optional" for an optional patient
    "encounter": "optional",        # adds an encounter/visit picker (encounter_id column)
    "employee": True,               # adds an employee picker (employee_id column) — HR entities
    "fields": [ ... ],
    "list": ["code", "patient_id", "machine", "scheduled_at", "status"],  # table columns
    "statuses": ["Scheduled", "In Progress", "Completed", "Cancelled"],   # first = initial
    "transitions": [               # if present, status changes ONLY through these buttons
        {"from": ["Scheduled"], "to": "In Progress", "label": "Start", "stamp": "started_at"},
        {"from": ["In Progress"], "to": "Completed", "label": "Complete", "tone": "success",
         "fields": ["post_weight", "notes"], "require": ["post_weight"]},
        {"from": "*", "to": "Cancelled", "label": "Cancel", "tone": "danger",
         "roles": ["doctor"], "confirm": "Cancel this session?"},
    ],
    "charge": {"on": "Completed", "code": "DIAL-HD"},   # auto charge capture → billing
    "title_field": "name",          # or "title_template": "{first_name} {last_name}"
    "date_field": "scheduled_at",   # drives date-range filters and "today" KPIs
    "sort": "-scheduled_at",        # default sort; "-" = descending
    "restricted": False,            # True → only `roles` may open it; clinicians can break the glass (audited)
    "readonly": False,              # True → created/edited only by engine code, not the generic form
    "code_editable": False,         # True → user may type the code (masters like tariff codes)
    "table": "records",             # leave default; core tables are reserved for engine modules
    "scope": {},                    # fixed filters when sharing a core table, e.g. {"type": "ER"}
}
```

Statuses without `transitions` are a plain dropdown on the form.
`stamp` writes the current timestamp into that key when the transition runs.
`fields` are shown in the transition dialog; `require` must be filled before it is allowed.

## Fields

```python
{"key": "machine", "label": "Machine", "type": "ref", "ref": "dialysis.machines", "required": True,
 "default": None, "help": "...", "placeholder": "...", "width": "half", "min": 0, "max": 10, "unit": "kg",
 "rows": 4, "options": [...], "readonly": False, "hidden": False}
```

| type | stored as | notes |
|---|---|---|
| `text`, `textarea`, `phone`, `email` | string | `rows` for textarea |
| `number`, `currency`, `percent`, `rating` | number | `min`/`max`/`unit` |
| `date` `datetime` `time` | ISO string | `default`: `"today"` / `"now"` |
| `select`, `multiselect`, `tags` | string / list | select needs `options` |
| `boolean` | bool | |
| `lines` | list of objects | `fields`: the line columns (any type except lines) |
| `signature` | data URL | tap-to-sign pad |
| `file` | file id | upload via /api/files |
| `ref` | id | `ref: "<module>.<entity>"`, optional `filter: {...}` |
| `patient` `encounter` | id | shorthand refs |
| `doctor` `nurse` `staff` | employee id | `default: "me"` = current user's employee |
| `department` `ward` `item` `drug` `service` `vendor` `bed` | id | shorthand refs to masters; `service` accepts `category` (LAB, RAD, PROC…) |

Reserved keys (not allowed as field keys): `id code status created_at created_by updated_at
updated_by deleted_at data search branch_id module entity`. A field named `title` becomes the
record title.

Shorthand targets: patient → `registration.patients`, encounter → `ipd.encounters`,
doctor/nurse/staff → `employees.employees`, department → `mdm.departments`, ward → `mdm.wards`,
item/drug → `mdm.items`, service → `billing.services`, vendor → `procurement.vendors`,
bed → `ipd.beds`.

## KPIs

```python
"kpis": [
    {"label": "Sessions today", "entity": "sessions", "period": "today"},
    {"label": "Revenue this month", "entity": "sessions", "agg": "sum", "field": "amount",
     "period": "month", "format": "currency"},
    {"label": "In progress", "entity": "sessions", "where": {"status": ["In Progress"]}},
]
```

`agg`: count | sum | avg · `period`: today | month | all (uses `date_field`, else created date)
· `format`: number | currency | percent | minutes.

## Charge capture

`charge` posts a line to the patient's unbilled charges when the record is created
(`"on": "create"`) or reaches a status. Price comes from:
- `service_field` — a field of type `service` (tariff rate), or
- `code` — a tariff service code (see `app/seed/tariff.py`), or
- `rate_field` — a currency field on the record (overrides tariff).
`qty_field` / `qty` multiply it.

## Engine hooks

Business rules live in `backend/app/engines/*.py`:

```python
from app.core.hooks import hook

@hook("dialysis.sessions", "before_transition")
async def check_machine(ctx, nxt, prev):
    ...
```
