"""Small helpers that keep the form library readable. Every helper returns a plain dict in the
definition format described in ``spec.py``."""

from __future__ import annotations

from typing import Any

YES_NO = ["Yes", "No"]
YES_NO_NA = ["Yes", "No", "N/A"]


def _f(key: str, label: str | None, type_: str, **kw: Any) -> dict:
    d: dict[str, Any] = {"key": key, "type": type_}
    if label:
        d["label"] = label
    d.update({k: v for k, v in kw.items() if v is not None})
    return d


def text(key: str, label: str | None = None, **kw: Any) -> dict:
    return _f(key, label, "text", **kw)


def ta(key: str, label: str | None = None, rows: int = 3, **kw: Any) -> dict:
    """Narrative textarea — gets Templates, Dictate and Copy-from tools in the runner."""
    return _f(key, label, "textarea", rows=rows, **kw)


def num(key: str, label: str | None = None, unit: str | None = None, lo: float | None = None, hi: float | None = None, **kw: Any) -> dict:
    return _f(key, label, "number", unit=unit, min=lo, max=hi, **kw)


def sel(key: str, label: str | None, options: list[str], **kw: Any) -> dict:
    return _f(key, label, "select", options=list(options), **kw)


def seg(key: str, label: str | None, options: list[str], **kw: Any) -> dict:
    """Select rendered as segmented buttons."""
    return _f(key, label, "select", options=list(options), ui="segmented", **kw)


def multi(key: str, label: str | None, options: list[str], **kw: Any) -> dict:
    return _f(key, label, "multiselect", options=list(options), **kw)


def yn(key: str, label: str | None = None, na: bool = False, **kw: Any) -> dict:
    return _f(key, label, "yesno", options=YES_NO_NA if na else YES_NO, **kw)


def yn_opts(key: str, label: str | None, options: list[str], **kw: Any) -> dict:
    return _f(key, label, "yesno", options=list(options), **kw)


def boolean(key: str, label: str | None = None, **kw: Any) -> dict:
    return _f(key, label, "boolean", **kw)


def choice(key: str, label: str | None, options: list[tuple], **kw: Any) -> dict:
    """Scored single choice. options: (value, score) or (value, score, help)."""
    opts = []
    for o in options:
        d: dict[str, Any] = {"value": o[0], "score": o[1]}
        if len(o) > 2 and o[2]:
            d["help"] = o[2]
        opts.append(d)
    return _f(key, label, "choice", options=opts, **kw)


def scale(key: str, label: str | None = None, lo: int = 0, hi: int = 10, **kw: Any) -> dict:
    return _f(key, label, "scale", min=lo, max=hi, **kw)


def calc(key: str, label: str | None, fn: str, args: list[str], unit: str | None = None, decimals: int = 1, **kw: Any) -> dict:
    return _f(key, label, "computed", compute={"fn": fn, "args": args, "decimals": decimals}, unit=unit, **kw)


def dt(key: str = "noted_at", label: str | None = "Date & time", default: str | None = "now", **kw: Any) -> dict:
    return _f(key, label, "datetime", default=default, **kw)


def date(key: str, label: str | None = None, **kw: Any) -> dict:
    return _f(key, label, "date", **kw)


def time(key: str, label: str | None = None, **kw: Any) -> dict:
    return _f(key, label, "time", **kw)


def staff(key: str, label: str | None = None, kind: str = "staff", **kw: Any) -> dict:
    return _f(key, label, kind, **kw)


def doctor(key: str, label: str | None = None, **kw: Any) -> dict:
    return _f(key, label, "doctor", **kw)


def nurse(key: str, label: str | None = None, **kw: Any) -> dict:
    return _f(key, label, "nurse", **kw)


def lines(key: str, label: str | None, fields: list[dict], **kw: Any) -> dict:
    return _f(key, label, "lines", fields=fields, **kw)


def info(key: str, text_: str, tone: str = "blue") -> dict:
    return {"key": key, "type": "info", "label": " ", "help": text_, "tone": tone}


def sign(key: str = "signature", label: str = "Signature", **kw: Any) -> dict:
    return _f(key, label, "signature", **kw)


def when(field: str, **cond: Any) -> dict:
    """Condition helper: when("x", eq="Yes"), when("x", in_=[...]), when("x", gte=3), when("x", truthy=True)."""
    out: dict[str, Any] = {"field": field}
    for k, v in cond.items():
        out[k.rstrip("_")] = v
    return out


def section(title: str, *fields: dict, key: str | None = None, desc: str | None = None, tone: str | None = None,
            show_if: dict | None = None, collapsed: bool = False) -> dict:
    d: dict[str, Any] = {"title": title, "fields": list(fields)}
    if key:
        d["key"] = key
    if desc:
        d["description"] = desc
    if tone:
        d["tone"] = tone
    if show_if:
        d["show_if"] = show_if
    if collapsed:
        d["collapsed"] = True
    return d


def band(label: str, tone: str, lo: float | None = None, hi: float | None = None, lt: float | None = None, action: str | None = None,
         reassess: float | None = None, task: str | None = None, priority: str = "Urgent", category: str = "Other", alert: bool = False) -> dict:
    d: dict[str, Any] = {"label": label, "tone": tone}
    if lo is not None:
        d["min"] = lo
    if hi is not None:
        d["max"] = hi
    if lt is not None:
        d["lt"] = lt
    if action:
        d["action"] = action
    if reassess is not None:
        d["reassess_hours"] = reassess
    if task:
        d["task"] = {"text": task, "priority": priority, "category": category}
    if alert:
        d["alert"] = True
    return d


def rng(score: float, lo: float | None = None, hi: float | None = None, lt: float | None = None) -> dict:
    d: dict[str, Any] = {"score": score}
    if lo is not None:
        d["min"] = lo
    if hi is not None:
        d["max"] = hi
    if lt is not None:
        d["lt"] = lt
    return d


def score(items: list[str], label: str, method: str = "sum", lo: float | None = None, hi: float | None = None, decimals: int = 0,
          unit: str | None = None, lower_is_worse: bool = False) -> dict:
    d: dict[str, Any] = {"method": method, "items": items, "label": label, "decimals": decimals}
    if lo is not None:
        d["min"] = lo
    if hi is not None:
        d["max"] = hi
    if unit:
        d["unit"] = unit
    if lower_is_worse:
        d["lower_is_worse"] = True
    return d


def compliance_bands(ok_label: str = "Compliant", gap_label: str = "Non-compliant", gap_action: str | None = None) -> list[dict]:
    return [
        band(ok_label, "green", lo=100, action="All applicable elements met (all-or-none)."),
        band(gap_label, "red", lt=100, action=gap_action or "Correct the missed elements now and inform the infection control nurse."),
    ]


# Shared option lists ------------------------------------------------------
RELATIONS = ["Self", "Spouse", "Father", "Mother", "Son", "Daughter", "Brother", "Sister", "Guardian", "Friend", "Other"]
LANGUAGES = ["Telugu", "Hindi", "English", "Tamil", "Kannada", "Malayalam", "Urdu", "Marathi", "Bengali", "Odia", "Gujarati", "Other"]
EDUCATION = ["Illiterate", "Primary", "Secondary", "Higher secondary", "Graduate", "Postgraduate", "Other"]
BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "Bombay (Oh)", "Unknown"]
O2_DEVICES = ["Room air", "Nasal prongs", "Face mask", "Venturi mask", "NRBM", "HFNC", "NIV (BiPAP/CPAP)", "Ventilator"]
TEMP_SITES = ["Oral", "Axillary", "Tympanic", "Rectal", "Temporal"]
LIMB_SITES = ["Right arm", "Left arm", "Right leg", "Left leg"]
SIDES = ["Left", "Right", "Bilateral", "Midline", "Not applicable"]
ANAESTHESIA = ["General (GA)", "Spinal", "Epidural", "Combined spinal-epidural", "Regional / nerve block", "MAC / sedation", "Local"]
ASA = ["ASA I", "ASA II", "ASA III", "ASA IV", "ASA V", "ASA VI", "ASA I E", "ASA II E", "ASA III E", "ASA IV E", "ASA V E"]
SHIFTS = ["Morning", "Evening", "Night"]
CONDITION = ["Stable", "Fair", "Guarded", "Critical"]
DIET_TYPES = ["Normal", "Soft", "Semi-solid", "Clear liquid", "Full liquid", "Diabetic", "Renal", "Cardiac / low salt", "High protein",
              "Low residue", "Liver / low fat", "NBM", "RT feed", "PEG / PEJ feed", "TPN"]
FOOD_PREF = ["Vegetarian", "Non-vegetarian", "Eggetarian", "Jain", "Vegan"]
MRC = ["0", "1", "2", "3", "4", "5"]
