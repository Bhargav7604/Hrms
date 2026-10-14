"""Clinical form definition spec.

A form definition is a plain dict (see `app/forms/library/*`) validated against these models.
Fields may use every Vlack record field type (text, textarea, number, select, multiselect, boolean,
date/datetime/time, lines, signature, file, ref and the ref shorthands doctor/nurse/staff/ward/…)
plus form-only types:

* ``choice``   — single choice whose options carry a score (Morse, Braden, GCS …)
* ``yesno``    — segmented Yes / No (/ N/A) used by checklists and bundles
* ``scale``    — integer 0…N picked from a segmented row (pain points)
* ``computed`` — read-only value derived by a named function (BMI, BSA, totals, counts …)
* ``info``     — static guidance text inside a section

Scoring: `score.items` lists the fields that contribute. A field contributes through its option
scores (choice), `score_map` (value → points), `score_ranges` (numeric bands) or `score_value`
(the raw number). `score.method` combines them; `bands` turn the total into a risk band with a
colour, recommended action, re-assessment interval and an optional nursing task.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, model_validator

from ..core.spec import FIELD_TYPE_NAMES

FORM_ONLY_TYPES = ["choice", "yesno", "scale", "computed", "info"]
FIELD_TYPES = set(FIELD_TYPE_NAMES) | set(FORM_ONLY_TYPES)
KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
FORM_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$")
TONES = Literal["green", "amber", "red", "blue", "gray", "violet", "cyan", "pink"]
COMPUTE_FNS = {
    "sum", "diff", "product", "ratio", "percent", "bmi", "bsa", "map", "score_sum", "count_yes", "percent_yes",
    "lines_sum", "lines_count", "lines_nonzero", "minutes_between", "hours_since", "days_since", "weight_change_pct",
}
COND_OPS = {"field", "eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "truthy", "all", "any"}

SUITES: list[dict[str, Any]] = [
    {"id": "nursing", "name": "Nursing", "icon": "HeartPulse", "tone": "pink",
     "description": "Nursing assessments and scored instruments."},
    {"id": "doctor", "name": "Doctor", "icon": "Stethoscope", "tone": "blue",
     "description": "Doctor assessments, orders and notes."},
    {"id": "monitoring", "name": "Monitoring", "icon": "Activity", "tone": "green",
     "description": "Critical-care and monitoring flowsheets."},
    {"id": "infection", "name": "Infection Control", "icon": "ShieldCheck", "tone": "cyan",
     "description": "Care-bundle checklists for device- and procedure-associated infections."},
    {"id": "safety", "name": "Patient Safety", "icon": "ShieldAlert", "tone": "amber",
     "description": "Incident reports, monitoring charts and safety double checks."},
    {"id": "dietary", "name": "Dietary", "icon": "Utensils", "tone": "violet",
     "description": "Nutrition screening, assessment and diet plans."},
    {"id": "ot", "name": "OT", "icon": "Scissors", "tone": "blue",
     "description": "The paperless OT file — 21 sheets from PAC to the SSI bundle."},
    {"id": "discharge", "name": "Discharge", "icon": "LogOut", "tone": "gray",
     "description": "Narrative discharge summary."},
    {"id": "op", "name": "OP Clinical Notes", "icon": "ClipboardPen", "tone": "blue",
     "description": "Specialty consultation-note formats for the OP EMR."},
]
SUITE_IDS = {s["id"] for s in SUITES}
SUITE_NAMES = {s["id"]: s["name"] for s in SUITES}
OT_GROUPS = ["Pre-op", "Intra-op", "Post-op"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Option(_Strict):
    value: str
    label: str | None = None
    score: float | None = None
    help: str | None = None


class Range(_Strict):
    """Numeric band: matches when min ≤ v ≤ max and v < lt (unset bounds are open)."""

    min: float | None = None
    max: float | None = None
    lt: float | None = None
    score: float = 0
    label: str | None = None


class Compute(_Strict):
    fn: str
    args: list[str] = []
    decimals: int = 1

    @model_validator(mode="after")
    def _fn(self) -> Compute:
        if self.fn not in COMPUTE_FNS:
            raise ValueError(f"unknown compute function {self.fn}")
        return self


class FormField(_Strict):
    key: str
    label: str | None = None
    type: str = "text"
    required: bool = False
    required_if: dict | None = None
    show_if: dict | None = None
    options: list[Option | str] | None = None
    ref: str | None = None
    filter: dict[str, Any] | None = None
    category: str | None = None
    kind: str | None = None
    default: Any = None
    prefill: str | None = None
    help: str | None = None
    placeholder: str | None = None
    unit: str | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    rows: int | None = None
    width: Literal["full", "half", "third", "quarter"] | None = None
    fields: list[FormField] | None = None
    score_ranges: list[Range] | None = None
    score_map: dict[str, float] | None = None
    score_value: bool = False
    compute: Compute | None = None
    ui: Literal["segmented", "radio", "dropdown", "chips"] | None = None
    dictation: bool | None = None
    templates: bool | None = None
    copy_from: list[str] | None = None
    tone: TONES | None = None
    readonly: bool = False

    @model_validator(mode="after")
    def _shape(self) -> FormField:
        if not KEY_RE.match(self.key):
            raise ValueError(f'field key "{self.key}" must be snake_case')
        if self.type not in FIELD_TYPES:
            raise ValueError(f'field "{self.key}": unknown type {self.type}')
        if self.type in ("select", "multiselect", "choice", "yesno") and not self.options:
            raise ValueError(f'field "{self.key}": {self.type} needs options')
        if self.type == "computed" and not self.compute:
            raise ValueError(f'field "{self.key}": computed needs `compute`')
        if self.type == "lines" and not self.fields:
            raise ValueError(f'field "{self.key}": lines need `fields`')
        if self.type == "ref" and not self.ref:
            raise ValueError(f'field "{self.key}": ref needs `ref`')
        return self

    # helpers -------------------------------------------------------------
    def option_values(self) -> list[str]:
        return [o.value if isinstance(o, Option) else o for o in (self.options or [])]

    def option(self, value: Any) -> Option | None:
        for o in self.options or []:
            if isinstance(o, Option) and o.value == value:
                return o
        return None


class Section(_Strict):
    key: str
    title: str
    description: str | None = None
    tone: TONES | None = None
    show_if: dict | None = None
    fields: list[FormField]
    collapsed: bool = False


class Task(_Strict):
    text: str
    priority: Literal["Routine", "Urgent", "STAT"] = "Urgent"
    category: str = "Other"


class Band(_Strict):
    label: str
    tone: TONES = "gray"
    min: float | None = None
    max: float | None = None
    lt: float | None = None
    action: str | None = None
    reassess_hours: float | None = None
    task: Task | None = None
    alert: bool = False


class Score(_Strict):
    method: Literal["sum", "max", "min", "value", "percent_yes", "count_yes"] = "sum"
    items: list[str]
    label: str
    min: float | None = None
    max: float | None = None
    decimals: int = 0
    unit: str | None = None
    lower_is_worse: bool = False


class Mirror(_Strict):
    kind: Literal["vitals", "incident", "bundle", "who_checklist"]
    when: dict | None = None
    options: dict[str, Any] = {}


class ImportFrom(_Strict):
    form: str
    label: str | None = None
    map: dict[str, str]


class FormDef(_Strict):
    key: str
    suite: str
    title: str
    short: str | None = None
    description: str | None = None
    icon: str | None = None
    also_in: list[str] = []
    group: str | None = None
    order: int = 0
    roles: list[str]  # may fill (create / edit drafts)
    view_roles: list[str]  # may open and read entries; roles and sign_roles are always included
    sign_roles: list[str] | None = None  # may sign / amend (default: roles)
    one_per_admission: bool = False
    multi_entry: bool = False
    restricted: bool = False
    component: Literal["io_flowsheet"] | None = None
    sections: list[Section] = []
    score: Score | None = None
    bands: list[Band] = []
    reassess_hours: float | None = None
    summary: list[str] | None = None
    mirror: list[Mirror] = []
    import_from: list[ImportFrom] = []
    match: list[str] = []
    version: int = 1

    @model_validator(mode="after")
    def _consistency(self) -> FormDef:
        if not FORM_KEY_RE.match(self.key):
            raise ValueError(f'form key "{self.key}" must look like "suite.name"')
        if self.suite not in SUITE_IDS:
            raise ValueError(f"unknown suite {self.suite}")
        for s in self.also_in:
            if s not in SUITE_IDS:
                raise ValueError(f"also_in: unknown suite {s}")
        if self.suite == "ot" and self.group not in OT_GROUPS:
            raise ValueError(f"OT sheets need group in {OT_GROUPS}")
        if not self.sections and not self.component:
            raise ValueError("form needs sections")
        from ..core.rbac import ROLES

        for r in [*self.roles, *self.view_roles, *(self.sign_roles or [])]:
            if r not in ROLES:
                raise ValueError(f"unknown role {r}")
        self.view_roles = sorted(set(self.view_roles) | set(self.roles) | set(self.sign_roles or []))
        keys: list[str] = []
        for sec in self.sections:
            keys += [f.key for f in sec.fields]
        dupes = {k for k in keys if keys.count(k) > 1}
        if dupes:
            raise ValueError(f"duplicate field keys {sorted(dupes)}")
        known = set(keys)
        fmap = {f.key: f for sec in self.sections for f in sec.fields}

        def check_cond(c: dict | None, where: str, scope: set[str]) -> None:
            if c is None:
                return
            bad = set(c) - COND_OPS
            if bad:
                raise ValueError(f"{where}: unknown condition keys {sorted(bad)}")
            for sub in [*(c.get("all") or []), *(c.get("any") or [])]:
                check_cond(sub, where, scope)
            if "field" in c and c["field"] not in scope:
                raise ValueError(f"{where}: condition refers to unknown field {c['field']}")

        for sec in self.sections:
            check_cond(sec.show_if, f"section {sec.key}", known)
            for f in sec.fields:
                check_cond(f.show_if, f"field {f.key}", known)
                check_cond(f.required_if, f"field {f.key}", known)
                if f.compute:
                    args = f.compute.args
                    if f.compute.fn.startswith("lines_"):
                        lf = fmap.get(args[0]) if args else None
                        if not lf or lf.type != "lines":
                            raise ValueError(f"field {f.key}: {f.compute.fn} needs a lines field first")
                        cols = {c.key for c in lf.fields or []}
                        if any(a not in cols for a in args[1:]):
                            raise ValueError(f"field {f.key}: {f.compute.fn} column not in {args[0]}")
                    else:
                        for a in args:
                            if a not in known:
                                raise ValueError(f"field {f.key}: compute arg {a} is not a field")
                for sub in f.fields or []:
                    row_scope = {x.key for x in f.fields or []} | known
                    check_cond(sub.show_if, f"field {f.key}.{sub.key}", row_scope)
                    if sub.compute:
                        for a in sub.compute.args:
                            if a not in row_scope:
                                raise ValueError(f"field {f.key}.{sub.key}: compute arg {a} unknown")
        if self.score:
            for k in self.score.items:
                if k not in known:
                    raise ValueError(f"score item {k} is not a field")
                f = fmap[k]
                scored = (f.type == "choice" or f.score_map or f.score_ranges or f.score_value
                          or (f.type == "yesno" and self.score.method in ("percent_yes", "count_yes")))
                if not scored:
                    raise ValueError(f"score item {k} carries no score")
        if self.bands and not self.score:
            raise ValueError("bands need a score")
        for k in self.summary or []:
            if k not in known:
                raise ValueError(f"summary field {k} is not a field")
        for imp in self.import_from:
            for tgt in imp.map:
                if tgt not in known:
                    raise ValueError(f"import_from: target {tgt} is not a field")
        return self

    # helpers -------------------------------------------------------------
    def fields(self) -> list[FormField]:
        return [f for sec in self.sections for f in sec.fields]

    def field_map(self) -> dict[str, FormField]:
        return {f.key: f for f in self.fields()}

    def suites(self) -> list[str]:
        return [self.suite, *self.also_in]

    def can_view(self, role: str) -> bool:
        return role == "admin" or role in self.view_roles

    def can_write(self, role: str) -> bool:
        return role == "admin" or role in self.roles

    def can_sign(self, role: str) -> bool:
        return role == "admin" or role in (self.sign_roles or self.roles)

    def access(self, role: str) -> dict[str, bool]:
        return {"view": self.can_view(role), "fill": self.can_write(role), "sign": self.can_sign(role)}
