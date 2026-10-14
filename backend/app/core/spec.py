"""Module definition spec. Each file in app/modules/<suite>/<id>.py exports `MODULE = {...}`
which is validated against these models (unknown keys are rejected to catch typos).
Human-readable guide: docs/MODULE-SPEC.md
"""

from __future__ import annotations

import builtins
import re
from typing import Any, Literal  # noqa: UP035 — `list` is a field name in EntityDef

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SUITES = [
    {"id": "front-office", "no": 1, "name": "Front Office & Patient Access", "short": "Front Office"},
    {"id": "clinical", "no": 2, "name": "Clinical Care", "short": "Clinical"},
    {"id": "operations", "no": 3, "name": "Operations & Finance", "short": "Operations"},
    {"id": "governance", "no": 4, "name": "Insight & Governance", "short": "Governance"},
    {"id": "specialty", "no": 5, "name": "Specialty Modules", "short": "Specialty"},
    {"id": "hr", "no": 6, "name": "HR & Payroll", "short": "HR & Payroll"},
]
SUITE_IDS = {s["id"] for s in SUITES}

FieldType = Literal[
    "text", "textarea", "number", "currency", "percent", "date", "datetime", "time",
    "select", "multiselect", "boolean", "phone", "email", "ref", "lines", "signature",
    "file", "rating", "tags", "patient", "encounter",
    # shorthands, expanded to `ref`:
    "doctor", "nurse", "staff", "department", "ward", "item", "drug", "service", "vendor", "bed",
]

FIELD_TYPE_NAMES = list(FieldType.__args__)

SHORTHANDS: dict[str, dict[str, Any]] = {
    "patient": {"ref": "registration.patients"},
    "encounter": {"ref": "ipd.encounters"},
    "doctor": {"ref": "employees.employees", "filter": {"category": "Doctor"}},
    "nurse": {"ref": "employees.employees", "filter": {"category": "Nurse"}},
    "staff": {"ref": "employees.employees"},
    "department": {"ref": "mdm.departments"},
    "ward": {"ref": "mdm.wards"},
    "item": {"ref": "mdm.items"},
    "drug": {"ref": "mdm.items", "filter": {"type": "Drug"}},
    "service": {"ref": "billing.services"},
    "vendor": {"ref": "procurement.vendors"},
    "bed": {"ref": "ipd.beds"},
}

RESERVED_KEYS = {
    "id", "code", "status", "created_at", "created_by", "updated_at", "updated_by", "deleted_at",
    "data", "search", "branch_id", "module", "entity",
}
KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
CODE_SEQ_RE = re.compile(r"\{seq:(\d)\}")
CODE_TOKENS = {"prefix", "branch", "yy", "yyyy", "mm", "fy"}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class FieldDef(_Strict):
    key: str
    label: str | None = None
    type: FieldType = "text"
    required: bool = False
    options: list[str] | None = None
    ref: str | None = None
    filter: dict[str, Any] | None = None
    category: str | None = None  # type=service: restrict to a tariff category (LAB, RAD, PROC, ...)
    default: Any = None  # literal, or "today" | "now" | "me"
    help: str | None = None
    placeholder: str | None = None
    min: float | None = None
    max: float | None = None
    unit: str | None = None
    width: Literal["full", "half", "third"] | None = None
    rows: int | None = None
    fields: list[FieldDef] | None = None  # type=lines: the columns of each line
    readonly: bool = False  # shown, but set by the system
    hidden: bool = False
    kind: str | None = None  # filled in by expansion (original shorthand)

    @field_validator("key")
    @classmethod
    def _key(cls, v: str) -> str:
        if not KEY_RE.match(v):
            raise ValueError("field key must be snake_case")
        if v in RESERVED_KEYS:
            raise ValueError(f'"{v}" is a reserved key')
        return v

    @model_validator(mode="after")
    def _shape(self) -> FieldDef:
        if self.type in ("select", "multiselect") and not self.options:
            raise ValueError(f'field "{self.key}": select needs options')
        if self.type == "ref" and not self.ref:
            raise ValueError(f'field "{self.key}": ref needs `ref`')
        if self.type == "lines" and not self.fields:
            raise ValueError(f'field "{self.key}": lines need `fields`')
        return self

    def expanded(self) -> FieldDef:
        data = self.model_dump()
        sh = SHORTHANDS.get(self.type)
        if sh:
            data["kind"] = self.type
            data["ref"] = self.ref or sh["ref"]
            flt = dict(sh.get("filter") or {})
            flt.update(self.filter or {})
            if self.type == "service" and self.category:
                flt["category"] = self.category
            data["filter"] = flt or None
            data["type"] = "ref"
        if not data.get("label"):
            from .util import humanize

            data["label"] = humanize(self.key)
        if not data.get("width"):
            full = self.type in ("textarea", "lines", "signature", "patient") or data.get("kind") == "patient"
            data["width"] = "full" if full else "half"
        if self.fields:
            data["fields"] = [f.expanded().model_dump() for f in self.fields]
        return FieldDef.model_validate(data)


class TransitionDef(_Strict):
    from_: list[str] | Literal["*"] = Field(alias="from")
    to: str
    label: str
    roles: list[str] | None = None
    require: list[str] | None = None  # fields that must have a value before this transition
    fields: list[str] | None = None  # fields captured in the transition dialog
    stamp: str | None = None  # data key set to the current timestamp, e.g. "completed_at"
    confirm: str | None = None  # confirmation question shown before applying
    tone: Literal["primary", "success", "danger", "warning", "neutral"] = "primary"

    @field_validator("from_", mode="before")
    @classmethod
    def _from(cls, v):
        return v if v == "*" or isinstance(v, list) else [v]


class ChargeDef(_Strict):
    on: str = "create"  # "create" or the status that triggers the charge
    service_field: str | None = None  # field holding a billing.services ref
    code: str | None = None  # or a fixed tariff service code
    qty_field: str | None = None
    qty: float = 1
    rate_field: str | None = None  # field holding an amount that overrides the tariff rate
    label: str | None = None

    @model_validator(mode="after")
    def _src(self) -> ChargeDef:
        if not (self.service_field or self.code or self.rate_field):
            raise ValueError("charge needs service_field, code or rate_field")
        return self


class KpiDef(_Strict):
    label: str
    entity: str
    agg: Literal["count", "sum", "avg"] = "count"
    field: str | None = None
    where: dict[str, Any] = {}
    period: Literal["today", "month", "all"] = "all"
    format: Literal["number", "currency", "percent", "minutes"] = "number"


class PageDef(_Strict):
    key: str
    label: str
    icon: str | None = None
    roles: list[str] | None = None


class EntityDef(_Strict):
    key: str
    label: str
    singular: str | None = None
    description: str | None = None
    icon: str | None = None
    prefix: str | None = None
    code_digits: int = 6
    code_sep: str = "-"
    code_editable: bool = False
    table: str = "records"
    scope: dict[str, Any] = {}
    patient: bool | Literal["optional"] = False
    encounter: bool | Literal["optional"] = False
    employee: bool | Literal["optional"] = False
    fields: builtins.list[FieldDef] = []
    list: builtins.list[str] | None = None
    statuses: builtins.list[str] | None = None
    transitions: builtins.list[TransitionDef] = []
    charge: ChargeDef | None = None
    roles: builtins.list[str] | None = None
    read_roles: builtins.list[str] | None = None
    restricted: bool = False
    break_glass: bool = True  # restricted only: may clinicians open it with an audited reason? (False for POSH)
    readonly: bool = False  # engine-managed: no create/edit from the generic UI
    title_field: str | None = None
    title_template: str | None = None  # e.g. "{first_name} {last_name}"
    sort: str = "-created_at"
    date_field: str | None = None
    # Branch scoping: shared masters (departments, tariff, drugs, patients…) are visible from every
    # branch; operational records are listed per active branch. None = decided by the registry's
    # central SHARED_ENTITIES list.
    shared: bool | None = None
    # Structured numbering, e.g. "{branch}IP{yy}{mm}{seq:5}" → 01IP261000053. Tokens: {prefix}
    # {branch} (2-digit branch no.) {yy} {yyyy} {mm} {fy} (Indian FY, 2627) {seq:N}. The sequence
    # restarts whenever the rendered non-sequence part changes (per branch / month / FY).
    code_pattern: str | None = None

    @field_validator("key")
    @classmethod
    def _key(cls, v: str) -> str:
        if not KEY_RE.match(v):
            raise ValueError("entity key must be snake_case")
        return v

    @field_validator("code_pattern")
    @classmethod
    def _pattern(cls, v):
        if v is None:
            return v
        seqs = CODE_SEQ_RE.findall(v)
        if len(seqs) != 1 or not 3 <= int(seqs[0]) <= 9:
            raise ValueError("code_pattern needs exactly one {seq:N} with N between 3 and 9")
        rest = CODE_SEQ_RE.sub("", v)
        for tok in re.findall(r"\{([^}]*)\}", rest):
            if tok not in CODE_TOKENS:
                raise ValueError(f"code_pattern: unknown token {{{tok}}}")
        if not re.fullmatch(r"[A-Za-z0-9/{}:-]*", v):
            raise ValueError("code_pattern may only contain letters, digits, '-', '/' and tokens")
        return v

    @field_validator("prefix")
    @classmethod
    def _prefix(cls, v):
        if v is not None and not re.match(r"^[A-Z]{2,5}$", v):
            raise ValueError("prefix must be 2-5 capital letters")
        return v

    @model_validator(mode="after")
    def _consistency(self) -> EntityDef:
        keys = [f.key for f in self.fields]
        dupes = {k for k in keys if keys.count(k) > 1}
        if dupes:
            raise ValueError(f"duplicate fields: {sorted(dupes)}")
        sts = self.statuses or []
        for t in self.transitions:
            if t.to not in sts:
                raise ValueError(f'transition "{t.label}" goes to unknown status "{t.to}"')
            if t.from_ != "*":
                bad = [s for s in t.from_ if s not in sts]
                if bad:
                    raise ValueError(f'transition "{t.label}" from unknown status {bad}')
        if not self.fields and not (self.patient or self.employee):
            raise ValueError("entity needs fields")
        return self


class ModuleDef(_Strict):
    no: int = Field(ge=1)
    id: str
    suite: str
    name: str
    icon: str
    summary: str
    features: list[str] = Field(min_length=1)
    roles: list[str] = []
    read_roles: list[str] = []
    pages: list[PageDef] = []
    entities: list[EntityDef] = []
    kpis: list[KpiDef] = []

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not re.match(r"^[a-z][a-z0-9]*$", v):
            raise ValueError("module id must be lowercase alphanumeric")
        return v

    @field_validator("suite")
    @classmethod
    def _suite(cls, v: str) -> str:
        if v not in SUITE_IDS:
            raise ValueError(f"unknown suite {v}")
        return v

    @model_validator(mode="after")
    def _has_content(self) -> ModuleDef:
        if not (self.entities or self.pages):
            raise ValueError("module needs at least one entity or page")
        keys = [e.key for e in self.entities]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate entity keys")
        return self
