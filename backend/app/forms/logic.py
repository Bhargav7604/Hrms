"""Form evaluation: conditional visibility, computed values, scoring, risk bands and server-side
validation of answers against a definition.

The web client (web/src/features/forms/logic.ts) implements the same rules for the live score;
the server result is authoritative and is what gets stored."""

from __future__ import annotations

import math
from datetime import date, datetime
from typing import Any

from ..core import records as rs
from ..core.spec import FieldDef
from ..core.util import now, parse_date, parse_dt, today
from .spec import Band, FormDef, FormField, Range

EMPTY = (None, "", [])


def empty(v: Any) -> bool:
    return v is None or v == "" or v == [] or v == {}


def _num(v: Any) -> float | None:
    if v is None or v == "" or isinstance(v, bool):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


# ------------------------------------------------------------------ conditions

def cond_ok(c: dict | None, values: dict) -> bool:
    if not c:
        return True
    if "all" in c and not all(cond_ok(x, values) for x in c["all"] or []):
        return False
    if "any" in c and not any(cond_ok(x, values) for x in c["any"] or []):
        return False
    if "field" not in c:
        return True
    v = values.get(c["field"])
    if "truthy" in c:
        ok = not empty(v) and v is not False and v != "No"
        if ok != bool(c["truthy"]):
            return False
    if "eq" in c and not _same(v, c["eq"]):
        return False
    if ("ne" in c or "nin" in c) and empty(v):
        return False  # "not X" needs an answer — an unanswered field satisfies neither branch
    if "ne" in c and _same(v, c["ne"]):
        return False
    if "in" in c and not (any(_same(x, v) for x in c["in"]) or (isinstance(v, list) and any(x in v for x in c["in"]))):
        return False
    if "nin" in c and (any(_same(x, v) for x in c["nin"]) or (isinstance(v, list) and any(x in v for x in c["nin"]))):
        return False
    n = _num(v)
    for op in ("gt", "gte", "lt", "lte"):
        if op in c:
            if n is None:
                return False
            t = float(c[op])
            if (op == "gt" and not n > t) or (op == "gte" and not n >= t) or (op == "lt" and not n < t) or (op == "lte" and not n <= t):
                return False
    return True


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b or (a in (True, "Yes") and b in (True, "Yes")) or (a in (False, "No") and b in (False, "No"))
    na, nb = _num(a), _num(b)
    if na is not None and nb is not None:
        return na == nb
    return a == b


def in_range(v: float, r: Range | Band) -> bool:
    return (r.min is None or v >= r.min) and (r.max is None or v <= r.max) and (r.lt is None or v < r.lt)


# ------------------------------------------------------------------ item scores

def item_score(f: FormField, v: Any) -> float | None:
    if empty(v):
        return None
    if f.type == "choice":
        o = f.option(v)
        return o.score if o else None
    if f.score_map is not None:
        return f.score_map.get(str(v))
    n = _num(v)
    if n is None:
        return None
    if f.score_ranges:
        for r in f.score_ranges:
            if in_range(n, r):
                return r.score
        return None
    if f.score_value:
        return n
    return None


# ------------------------------------------------------------------ computed values

def _dt(v: Any) -> datetime | None:
    if empty(v):
        return None
    try:
        return parse_dt(v)
    except (ValueError, TypeError):
        return None


def _minutes_between(a: Any, b: Any) -> float | None:
    if isinstance(a, str) and isinstance(b, str) and len(a) == 5 and len(b) == 5 and a[2] == ":" and b[2] == ":":
        try:
            ma, mb = int(a[:2]) * 60 + int(a[3:]), int(b[:2]) * 60 + int(b[3:])
        except ValueError:
            return None
        return float((mb - ma) % 1440)
    da, db = _dt(a), _dt(b)
    if not da or not db:
        return None
    return (db - da).total_seconds() / 60


def compute(fn: str, args: list[str], values: dict, fmap: dict[str, FormField], decimals: int = 1) -> Any:
    vals = [values.get(a) for a in args]
    nums = [_num(v) for v in vals]
    out: float | None = None
    if fn == "sum":
        present = [n for n in nums if n is not None]
        out = sum(present) if present else None
    elif fn == "diff":
        out = nums[0] - nums[1] if len(nums) == 2 and None not in nums else None
    elif fn == "product":
        out = math.prod(nums) if nums and None not in nums else None
    elif fn in ("ratio", "percent"):
        if len(nums) == 2 and None not in nums and nums[1]:
            out = nums[0] / nums[1] * (100 if fn == "percent" else 1)
    elif fn == "bmi":
        w, h = nums[0], nums[1]
        out = w / (h / 100) ** 2 if w and h and h > 30 else None
    elif fn == "bsa":
        h, w = nums[0], nums[1]
        out = math.sqrt(h * w / 3600) if h and w and h > 30 else None
    elif fn == "map":
        s, d = nums[0], nums[1]
        out = (s + 2 * d) / 3 if s is not None and d is not None else None
    elif fn == "score_sum":
        scores = [item_score(fmap[a], values.get(a)) for a in args if a in fmap]
        present = [s for s in scores if s is not None]
        out = sum(present) if present else None
    elif fn == "count_yes":
        answered = [v for v in vals if not empty(v)]
        out = float(sum(1 for v in vals if v in ("Yes", True))) if answered else None
    elif fn == "percent_yes":
        yes = sum(1 for v in vals if v in ("Yes", True))
        no = sum(1 for v in vals if v in ("No", False))
        out = yes / (yes + no) * 100 if yes + no else None
    elif fn in ("lines_sum", "lines_count", "lines_nonzero"):
        rows = values.get(args[0]) or []
        rows = rows if isinstance(rows, list) else []
        if fn == "lines_count":
            out = float(len(rows)) if rows else None
        else:
            col = args[1] if len(args) > 1 else ""
            cells = [_num(r.get(col)) for r in rows if isinstance(r, dict)]
            if fn == "lines_sum":
                present = [c for c in cells if c is not None]
                out = sum(present) if present else None
            else:
                out = float(sum(1 for c in cells if c not in (None, 0))) if rows else None
    elif fn == "minutes_between":
        out = _minutes_between(vals[0], vals[1]) if len(vals) == 2 else None
    elif fn == "hours_since":
        d = _dt(vals[0]) if vals else None
        out = (now() - d).total_seconds() / 3600 if d else None
    elif fn == "days_since":
        try:
            d = parse_date(vals[0]) if vals and not empty(vals[0]) else None
        except (ValueError, TypeError):
            d = None
        out = float((today() - d).days) if isinstance(d, date) else None
    elif fn == "weight_change_pct":
        a, b = nums[0], nums[1]
        out = (b - a) / a * 100 if a and b is not None else None
    if out is None:
        return None
    out = round(out, decimals)
    return int(out) if decimals == 0 else out


def apply_computed(form: FormDef, values: dict) -> dict:
    """Fill computed fields (also inside lines rows). Three passes resolve chained computations."""
    fmap = form.field_map()
    out = dict(values)
    for _ in range(3):
        for f in fmap.values():
            if f.type == "lines" and isinstance(out.get(f.key), list):
                sub = {s.key: s for s in f.fields or []}
                rows = []
                for row in out[f.key]:
                    if not isinstance(row, dict):
                        continue
                    r = dict(row)
                    for s in f.fields or []:
                        if s.type == "computed" and s.compute:
                            r[s.key] = compute(s.compute.fn, s.compute.args, {**out, **r}, {**fmap, **sub}, s.compute.decimals)
                    rows.append(r)
                out[f.key] = rows
            elif f.type == "computed" and f.compute:
                out[f.key] = compute(f.compute.fn, f.compute.args, out, fmap, f.compute.decimals)
    return out


# ------------------------------------------------------------------ visibility

def visible_keys(form: FormDef, values: dict) -> set[str]:
    keys: set[str] = set()
    for sec in form.sections:
        if not cond_ok(sec.show_if, values):
            continue
        for f in sec.fields:
            if cond_ok(f.show_if, values):
                keys.add(f.key)
    return keys


# ------------------------------------------------------------------ score

def evaluate(form: FormDef, answers: dict) -> dict:
    """Computed values + score + band for a set of answers (already coerced)."""
    values = apply_computed(form, answers)
    res: dict[str, Any] = {"values": values, "score": None, "band": None, "complete": False, "items": {}}
    sc = form.score
    if not sc:
        return res
    vis = visible_keys(form, values)
    fmap = form.field_map()
    items = [k for k in sc.items if k in vis]
    parts: dict[str, float | None] = {}
    for k in items:
        parts[k] = item_score(fmap[k], values.get(k))
    res["items"] = parts
    score: float | None = None
    if sc.method in ("percent_yes", "count_yes"):
        answered = [values.get(k) for k in items if not empty(values.get(k))]
        yes = sum(1 for v in answered if v in ("Yes", True))
        no = sum(1 for v in answered if v in ("No", False))
        if sc.method == "percent_yes":
            score = yes / (yes + no) * 100 if yes + no else None
        else:
            score = float(yes) if answered else None
        res["complete"] = bool(items) and len(answered) == len(items)
        res["counts"] = {"yes": yes, "no": no, "na": len(answered) - yes - no, "total": len(items)}
    else:
        present = [v for v in parts.values() if v is not None]
        if present:
            if sc.method == "sum":
                score = sum(present)
            elif sc.method == "max":
                score = max(present)
            elif sc.method == "min":
                score = min(present)
            else:
                score = present[0]
        res["complete"] = bool(items) and len(present) == len(items)
    if score is not None:
        score = round(score, sc.decimals)
        if sc.decimals == 0:
            score = int(score)
        res["score"] = score
        for b in form.bands:
            if in_range(float(score), b):
                res["band"] = b
                break
    return res


def band_public(b: Band | None) -> dict | None:
    return b.model_dump(exclude_none=True) if b else None


# ------------------------------------------------------------------ validation

def _core_field(f: FormField) -> FieldDef:
    t = f.type
    if t in ("choice", "yesno"):
        t = "select"
    elif t == "scale":
        t = "number"
    data: dict[str, Any] = {"key": f.key, "label": f.label or f.key, "type": t}
    if t in ("select", "multiselect"):
        data["options"] = f.option_values()
    for k in ("ref", "filter", "min", "max", "unit"):
        v = getattr(f, k)
        if v is not None:
            data[k] = v
    return FieldDef.model_validate(data)


def _coerce(ctx, f: FormField, v: Any, errors: dict, path: str, final: bool) -> Any:
    if f.type in ("info",):
        return None
    if f.type == "computed":
        return None  # recomputed
    if f.type == "lines":
        if empty(v):
            return None
        if not isinstance(v, list):
            errors[path] = f"{f.label}: expected a list of rows"
            return None
        rows = []
        for i, row in enumerate(v):
            if not isinstance(row, dict):
                continue
            clean: dict[str, Any] = {}
            for s in f.fields or []:
                if s.key in row:
                    cv = _coerce(ctx, s, row[s.key], errors, f"{path}.{i}.{s.key}", final)
                    if not empty(cv):
                        clean[s.key] = cv
            if not clean:
                continue
            if final:
                for s in f.fields or []:
                    if s.required and empty(clean.get(s.key)) and s.type != "computed":
                        errors[f"{path}.{len(rows)}.{s.key}"] = f"{s.label} is required"
            rows.append(clean)
        return rows or None
    if f.type == "scale":
        n = _num(v)
        if n is None:
            errors[path] = f"Invalid value for {f.label}"
            return None
        lo, hi = f.min if f.min is not None else 0, f.max if f.max is not None else 10
        if not lo <= n <= hi:
            errors[path] = f"{f.label} must be between {lo:g} and {hi:g}"
        return int(n) if float(n).is_integer() else n
    if f.type == "boolean" and isinstance(v, str) and v in ("Yes", "No"):
        v = v == "Yes"
    return rs._coerce(ctx, _core_field(f), v, errors, path)  # noqa: SLF001 — share the record service coercion


def validate_answers(ctx, form: FormDef, answers: dict, *, final: bool) -> tuple[dict, dict[str, str]]:
    """Coerce answers by type. `final` (sign / amend) also enforces required rules and drops values of
    hidden fields. Returns (clean answers incl. computed values, field errors)."""
    if not isinstance(answers, dict):
        return {}, {"answers": "Answers must be an object"}
    errors: dict[str, str] = {}
    clean: dict[str, Any] = {}
    for f in form.fields():
        if f.key not in answers:
            continue
        v = _coerce(ctx, f, answers[f.key], errors, f.key, final)
        if not empty(v):
            clean[f.key] = v
    values = apply_computed(form, clean)
    if final:
        vis = visible_keys(form, values)
        values = {k: v for k, v in values.items() if k in vis}
        for f in form.fields():
            if f.key not in vis or f.type in ("computed", "info") or f.readonly:
                continue
            need = f.required or (f.required_if is not None and cond_ok(f.required_if, values))
            if need and empty(values.get(f.key)):
                errors.setdefault(f.key, f"{f.label} is required")
    values = {k: v for k, v in values.items() if not empty(v)}
    return values, errors


def summary_line(form: FormDef, values: dict, ev: dict) -> str | None:
    fmap = form.field_map()
    parts: list[str] = []
    if form.score and ev.get("score") is not None:
        band = ev.get("band")
        unit = f" {form.score.unit}" if form.score.unit else ""
        parts.append(f"{form.score.label} {ev['score']}{unit}" + (f" · {band.label}" if band else ""))
    for k in form.summary or []:
        v = values.get(k)
        if empty(v):
            continue
        f = fmap[k]
        if isinstance(v, list):
            v = ", ".join(str(x) for x in v if not isinstance(x, dict)) or f"{len(v)} rows"
        elif f.type == "choice":
            o = f.option(v)
            v = (o.label or o.value) if o else v
        parts.append(f"{f.label}: {v}")
    if not parts:
        for f in form.fields():
            v = values.get(f.key)
            if f.type == "textarea" and isinstance(v, str) and v.strip():
                parts.append(v.strip().replace("\n", " "))
                break
    text = " · ".join(parts)
    return (text[:237] + "…") if len(text) > 240 else (text or None)
