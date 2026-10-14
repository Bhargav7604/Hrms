"""Clinical form library: declarative form definitions (``app/forms/library/*.py``) loaded and
validated once, then served to the web client and used by the forms engine for server-side
validation and scoring. See ``spec.py`` for the definition format and ``logic.py`` for scoring."""

from __future__ import annotations

import importlib
import pkgutil
from typing import Any

from pydantic import ValidationError

from ..core.spec import SHORTHANDS
from ..core.util import humanize
from .spec import SUITE_NAMES, SUITES, FormDef, FormField, Option

_forms: dict[str, FormDef] = {}
_errors: list[str] = []


def _normalise_field(raw: dict) -> dict:
    d = dict(raw)
    t = d.get("type", "text")
    if t in SHORTHANDS:
        sh = SHORTHANDS[t]
        d["kind"] = t
        d["ref"] = d.get("ref") or sh["ref"]
        flt = dict(sh.get("filter") or {})
        flt.update(d.get("filter") or {})
        if t == "service" and d.get("category"):
            flt["category"] = d["category"]
        d["filter"] = flt or None
        d["type"] = "ref"
    if not d.get("label"):
        d["label"] = humanize(d["key"])
    if d["type"] == "choice":
        d["options"] = [o if isinstance(o, dict) else {"value": str(o)} for o in d.get("options") or []]
    if d["type"] == "yesno" and not d.get("options"):
        d["options"] = ["Yes", "No"]
    if d["type"] == "textarea":
        d.setdefault("dictation", True)
        d.setdefault("templates", True)
    if not d.get("width"):
        if d["type"] in ("lines", "signature", "info", "multiselect") or (d["type"] == "choice" and d.get("ui") != "segmented"):
            d["width"] = "full"
        elif d["type"] in ("textarea", "scale"):
            d["width"] = "half"
        else:
            d["width"] = "quarter"
    if d.get("fields"):
        d["fields"] = [_normalise_field(s) for s in d["fields"]]
    return d


def _normalise(raw: dict) -> dict:
    d = dict(raw)
    secs = []
    for i, s in enumerate(d.get("sections") or []):
        s = dict(s)
        s.setdefault("key", f"s{i + 1}")
        s["fields"] = [_normalise_field(f) for f in s.get("fields") or []]
        secs.append(s)
    d["sections"] = secs
    return d


def load_forms(strict: bool = True) -> dict[str, FormDef]:
    if _forms:
        return _forms
    from . import library

    errors: list[str] = []
    for info in sorted(pkgutil.iter_modules(library.__path__), key=lambda i: i.name):
        mod = importlib.import_module(f"{library.__name__}.{info.name}")
        for raw in getattr(mod, "FORMS", []):
            key = raw.get("key", "?")
            try:
                fd = FormDef.model_validate(_normalise(raw))
            except ValidationError as e:
                for err in e.errors():
                    loc = ".".join(str(x) for x in err["loc"])
                    errors.append(f"forms/library/{info.name}.py {key}: {loc}: {err['msg']}")
                continue
            if fd.key in _forms:
                errors.append(f"duplicate form key {fd.key}")
                continue
            _forms[fd.key] = fd
    for fd in _forms.values():
        for imp in fd.import_from:
            if imp.form not in _forms:
                errors.append(f"{fd.key}: import_from unknown form {imp.form}")
        for sec in fd.sections:
            for f in sec.fields:
                for src in f.copy_from or []:
                    fk, _, fld = src.rpartition(".")
                    if fk not in _forms or fld not in _forms[fk].field_map():
                        errors.append(f"{fd.key}.{f.key}: copy_from unknown source {src}")
    _errors[:] = errors
    if errors and strict:
        raise RuntimeError("Clinical form definitions are invalid:\n  - " + "\n  - ".join(errors))
    return _forms


def get_form(key: str) -> FormDef | None:
    return load_forms().get(key)


def all_forms() -> list[FormDef]:
    return sorted(load_forms().values(), key=lambda f: (f.suite, f.group or "", f.order, f.title))


def field_public(f: FormField) -> dict[str, Any]:
    out = f.model_dump(exclude_none=True, exclude_defaults=True)
    out["key"], out["label"], out["type"] = f.key, f.label, f.type
    if f.options is not None:
        out["options"] = [o.model_dump(exclude_none=True) if isinstance(o, Option) else o for o in f.options]
    if f.fields:
        out["fields"] = [field_public(s) for s in f.fields]
    return out


def form_summary(fd: FormDef) -> dict[str, Any]:
    return {
        "key": fd.key, "suite": fd.suite, "suite_name": SUITE_NAMES[fd.suite], "also_in": fd.also_in, "title": fd.title,
        "short": fd.short, "description": fd.description, "icon": fd.icon, "group": fd.group, "order": fd.order,
        "roles": fd.roles, "sign_roles": fd.sign_roles or fd.roles, "one_per_admission": fd.one_per_admission,
        "multi_entry": fd.multi_entry, "restricted": fd.restricted, "component": fd.component,
        "scored": fd.score is not None, "score_label": fd.score.label if fd.score else None, "match": fd.match,
        "fields": sum(len(s.fields) for s in fd.sections),
    }


def form_public(fd: FormDef) -> dict[str, Any]:
    out = form_summary(fd)
    out.update(
        version=fd.version, reassess_hours=fd.reassess_hours, summary=fd.summary,
        score=fd.score.model_dump(exclude_none=True) if fd.score else None,
        bands=[b.model_dump(exclude_none=True) for b in fd.bands],
        sections=[{**s.model_dump(exclude={"fields"}, exclude_none=True), "fields": [field_public(f) for f in s.fields]} for s in fd.sections],
        import_from=[i.model_dump(exclude_none=True) for i in fd.import_from],
        mirror=[m.kind for m in fd.mirror],
    )
    return out


def load_errors() -> list[str]:
    return list(_errors)


__all__ = ["SUITES", "all_forms", "form_public", "form_summary", "get_form", "load_forms", "load_errors"]
