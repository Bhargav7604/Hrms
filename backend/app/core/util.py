from __future__ import annotations

import csv
import io
import uuid
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from fastapi import HTTPException

from ..config import settings


class ApiError(HTTPException):
    def __init__(self, status: int, message: str, details: Any = None, code: str | None = None):
        super().__init__(status_code=status, detail={"message": message, "details": details, "code": code})


def bad_request(msg: str, details: Any = None) -> ApiError:
    return ApiError(400, msg, details)


def not_found(msg: str = "Not found") -> ApiError:
    return ApiError(404, msg)


def forbidden(msg: str = "You do not have access to this", code: str | None = None) -> ApiError:
    return ApiError(403, msg, code=code)


def conflict(msg: str, details: Any = None) -> ApiError:
    return ApiError(409, msg, details)


def new_id() -> str:
    return str(uuid.uuid4())


def is_uuid(v: Any) -> bool:
    try:
        uuid.UUID(str(v))
        return True
    except (ValueError, TypeError):
        return False


def now() -> datetime:
    return datetime.now(settings.tz)


def today() -> date:
    return now().date()


def today_str() -> str:
    return today().isoformat()


def day_bounds(d: date) -> tuple[datetime, datetime]:
    start = datetime(d.year, d.month, d.day, tzinfo=settings.tz)
    return start, start + timedelta(days=1)


def parse_dt(v: Any) -> datetime | None:
    if v in (None, ""):
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=settings.tz)
    if isinstance(v, date):
        return datetime(v.year, v.month, v.day, tzinfo=settings.tz)
    s = str(v).strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=settings.tz)


def parse_date(v: Any) -> date | None:
    if v in (None, ""):
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


def money(v: Any) -> Decimal:
    return Decimal(str(v or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def to_json_value(v: Any) -> Any:
    """DB value → JSON-friendly value."""
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, datetime):
        return v.astimezone(settings.tz).isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


def age_from(dob: Any) -> int | None:
    d = parse_date(dob) if dob else None
    if not d:
        return None
    t = today()
    return t.year - d.year - ((t.month, t.day) < (d.month, d.day))


def minutes_between(a: Any, b: Any) -> int | None:
    da, db_ = parse_dt(a), parse_dt(b)
    if not da or not db_:
        return None
    return round((db_ - da).total_seconds() / 60)


def mask_id(v: str | None) -> str | None:
    if not v:
        return v
    s = "".join(str(v).split())
    return s if len(s) <= 4 else "X" * (len(s) - 4) + s[-4:]


def humanize(key: str) -> str:
    k = key[:-3] if key.endswith("_id") else key
    return " ".join(w.capitalize() for w in k.split("_"))


def to_csv(rows: list[dict], columns: list[tuple[str, str]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([label for _, label in columns])
    for r in rows:
        w.writerow(["" if r.get(k) is None else r.get(k) for k, _ in columns])
    return buf.getvalue()
