"""Module registry: loads every app/modules/<suite>/<id>.py, validates it against core.spec,
expands field shorthands and builds runtime Entity/Module objects used by the generic
record service, the meta API and the web client."""

from __future__ import annotations

import importlib
import pkgutil
from typing import Any

import sqlalchemy as sa
from pydantic import ValidationError

from ..schema import ENTITY_TABLES
from .rbac import ROLES
from .spec import SUITES, EntityDef, FieldDef, ModuleDef

SUITE_PACKAGES = ["front_office", "clinical", "operations", "governance", "specialty", "hr"]
BASE_LIST_COLUMNS = {"code", "status", "title", "created_at", "updated_at", "patient_id", "employee_id", "encounter_id"}

# Masters shared by every branch (catalogues, tariffs, people, templates, configuration). Every other
# entity is operational: created in the active branch and listed per branch. An entity can override
# this with `"shared": True/False` in its definition.
SHARED_ENTITIES = {
    # people & the master patient index
    "registration.patients", "employees.employees",
    # organisation masters
    "mdm.departments", "mdm.items", "mdm.specialties", "mdm.branches",
    "billing.services", "billing.packages", "crm.hc_packages", "insurance.payers",
    "lab.tests", "radiology.studies", "terminology.icd_codes", "terminology.terms",
    "procurement.vendors", "referrals.referral_doctors", "marketing.referral_sources",
    # templates & definitions
    "notifications.templates", "consents.templates", "documents.doc_types", "opd.templates",
    "radiology.report_templates", "registers.definitions", "feedback.surveys",
    "quality.indicators", "quality.checklist", "quality.documents",
    "training.courses", "training.requirements", "roster.shifts",
    # platform configuration
    "workflow.flows", "workflow.delegations", "command.alert_rules",
    "analytics.saved_reports", "analytics.dashboards", "analytics.metric_definitions",
    "connectors.connectors", "connectors.mappings", "connectors.api_clients",
    "aigov.models", "aigov.policies", "mdm.support_tickets",
}

# Structured document numbers (branch + period + sequence) for entities that opt in centrally.
# UHIDs keep 10 characters: 2-digit branch, 2-digit year, 6-digit sequence (0126000001).
# Bills stay within GST's 16-character invoice-number limit and restart every financial year.
CODE_PATTERNS = {
    "ipd.admissions": "{branch}IP{yy}{mm}{seq:5}",
    "registration.patients": "{branch}{yy}{seq:6}",
    "billing.invoices": "{prefix}{branch}{fy}-{seq:6}",
}


class Entity:
    def __init__(self, module: Module, d: EntityDef):
        self.module_id = module.id
        self.module = module
        self.key = d.key
        self.fqn = f"{module.id}.{d.key}"
        self.d = d
        fields = [f.expanded() for f in d.fields]
        if d.patient and not any(f.key == "patient_id" for f in fields):
            fields.insert(0, FieldDef(key="patient_id", label="Patient", type="patient", required=d.patient is True).expanded())
        if d.employee and not any(f.key == "employee_id" for f in fields):
            fields.insert(0, FieldDef(key="employee_id", label="Employee", type="staff", required=d.employee is True).expanded())
        if d.encounter and not any(f.key == "encounter_id" for f in fields):
            pos = 1 if d.patient else 0
            fields.insert(pos, FieldDef(key="encounter_id", label="Encounter / Visit", type="encounter", required=d.encounter is True).expanded())
        self.fields = fields
        self.field_map = {f.key: f for f in fields}
        self.table: sa.Table = ENTITY_TABLES[d.table]
        self.physical = set(self.table.c.keys())
        # field keys stored in typed columns (everything else goes to `data`)
        self.columns = {f.key for f in fields if f.key in self.physical}
        self.singular = d.singular or _singular(d.label)
        self.prefix = d.prefix or "".join(ch for ch in d.key.upper() if ch.isalpha())[:3]
        self.list_cols = d.list or _default_list(fields)
        self.shared: bool = d.shared if d.shared is not None else self.fqn in SHARED_ENTITIES
        self.code_pattern: str | None = d.code_pattern or CODE_PATTERNS.get(self.fqn)

    def __getattr__(self, name: str) -> Any:  # delegate to the definition
        return getattr(self.d, name)

    def public(self) -> dict:
        out = self.d.model_dump(by_alias=True, exclude_none=True)
        out.update(
            fqn=self.fqn, module=self.module_id, singular=self.singular, prefix=self.prefix,
            fields=[f.model_dump(exclude_none=True) for f in self.fields], list=self.list_cols,
            shared=self.shared,
        )
        if self.code_pattern:
            out["code_pattern"] = self.code_pattern
        return out


class Module:
    def __init__(self, d: ModuleDef):
        self.d = d
        self.id = d.id
        self.entities: list[Entity] = [Entity(self, e) for e in d.entities]
        self.entity_map = {e.key: e for e in self.entities}

    def __getattr__(self, name: str) -> Any:
        return getattr(self.d, name)

    def public(self) -> dict:
        out = self.d.model_dump(exclude={"entities"}, exclude_none=True)
        out["entities"] = [e.public() for e in self.entities]
        return out


def _singular(label: str) -> str:
    if label.endswith("ies"):
        return label[:-3] + "y"
    if label.endswith(("ses", "xes")):
        return label[:-2]
    return label[:-1] if label.endswith("s") else label


def _default_list(fields: list[FieldDef]) -> list[str]:
    skip = {"textarea", "lines", "signature", "file"}
    return ["code", *[f.key for f in fields if f.type not in skip][:5], "status"]


_modules: list[Module] = []
_by_id: dict[str, Module] = {}
_entities: dict[str, Entity] = {}


def load_registry(strict: bool = True) -> tuple[list[Module], list[str]]:
    if _modules:
        return _modules, []
    errors: list[str] = []
    for pkg in SUITE_PACKAGES:
        package = importlib.import_module(f"app.modules.{pkg}")
        for info in sorted(pkgutil.iter_modules(package.__path__), key=lambda i: i.name):
            where = f"modules/{pkg}/{info.name}.py"
            try:
                raw = importlib.import_module(f"app.modules.{pkg}.{info.name}").MODULE
            except Exception as e:  # noqa: BLE001
                errors.append(f"{where}: failed to import — {e!r}")
                continue
            try:
                d = ModuleDef.model_validate(raw)
            except ValidationError as e:
                for err in e.errors():
                    loc = ".".join(str(x) for x in err["loc"])
                    errors.append(f"{where}: {loc}: {err['msg']}")
                continue
            if d.id in _by_id:
                errors.append(f"{where}: duplicate module id {d.id}")
                continue
            m = Module(d)
            _modules.append(m)
            _by_id[m.id] = m
            for e in m.entities:
                _entities[e.fqn] = e
    _modules.sort(key=lambda m: m.no)
    errors.extend(_validate_graph())
    if errors and strict:
        raise RuntimeError("Module definitions are invalid:\n  - " + "\n  - ".join(errors))
    return _modules, errors


def _validate_graph() -> list[str]:
    errs: list[str] = []
    nos: dict[int, str] = {}
    prefixes: dict[str, str] = {}
    for m in _modules:
        if m.no in nos:
            errs.append(f"module no {m.no} used by both {nos[m.no]} and {m.id}")
        nos[m.no] = m.id
        for r in [*m.roles, *m.read_roles]:
            if r not in ROLES:
                errs.append(f"{m.id}: unknown role {r}")
        for k in m.kpis:
            ent = m.entity_map.get(k.entity)
            if not ent:
                errs.append(f"{m.id}: kpi '{k.label}' uses unknown entity {k.entity}")
            elif k.field and k.field not in ent.field_map and k.field not in ent.physical:
                errs.append(f"{m.id}: kpi '{k.label}' uses unknown field {k.field}")
    for ent in _entities.values():
        where = ent.fqn
        if ent.prefix in prefixes:
            errs.append(f"{where}: code prefix {ent.prefix} already used by {prefixes[ent.prefix]}")
        prefixes[ent.prefix] = where
        for r in [*(ent.roles or []), *(ent.read_roles or [])]:
            if r not in ROLES:
                errs.append(f"{where}: unknown role {r}")

        def walk(fields: list[FieldDef], path: str, where: str = where) -> None:
            for f in fields:
                if f.type == "ref" and f.ref not in _entities:
                    errs.append(f"{where}.{path}{f.key}: ref target '{f.ref}' does not exist")
                if f.type == "lines":
                    walk(f.fields or [], f"{f.key}.")

        walk(ent.fields, "")
        for c in ent.list_cols:
            if c not in BASE_LIST_COLUMNS and c not in ent.field_map:
                errs.append(f"{where}: list column '{c}' is not a field")
        if ent.title_field and ent.title_field not in ent.field_map:
            errs.append(f"{where}: title_field '{ent.title_field}' is not a field")
        if ent.date_field and ent.date_field not in ent.field_map and ent.date_field not in ent.physical:
            errs.append(f"{where}: date_field '{ent.date_field}' is not a field")
        ch = ent.charge
        if ch:
            for k in (ch.service_field, ch.qty_field, ch.rate_field):
                if k and k not in ent.field_map:
                    errs.append(f"{where}: charge field '{k}' is not a field")
            if ch.on != "create" and ch.on not in (ent.statuses or []):
                errs.append(f"{where}: charge.on '{ch.on}' is not a status")
            if not ent.d.patient:
                errs.append(f"{where}: charge capture needs a patient-linked entity")
        for t in ent.transitions:
            for k in [*(t.require or []), *(t.fields or [])]:
                if k not in ent.field_map:
                    errs.append(f"{where}: transition '{t.label}' references unknown field '{k}'")
            for r in t.roles or []:
                if r not in ROLES:
                    errs.append(f"{where}: transition '{t.label}' unknown role {r}")
    return errs


def all_modules() -> list[Module]:
    return _modules


def get_module(module_id: str) -> Module | None:
    return _by_id.get(module_id)


def get_entity(fqn: str) -> Entity | None:
    return _entities.get(fqn)


def all_entities() -> list[Entity]:
    return list(_entities.values())


def suites() -> list[dict]:
    return SUITES
