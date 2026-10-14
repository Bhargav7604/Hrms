from __future__ import annotations

from sqlalchemy.dialects.postgresql import insert

from ..schema import sequences


async def next_seq(conn, key: str) -> int:
    stmt = insert(sequences).values(key=key, value=1)
    stmt = stmt.on_conflict_do_update(index_elements=[sequences.c.key], set_={"value": sequences.c.value + 1})
    return (await conn.execute(stmt.returning(sequences.c.value))).scalar_one()


async def next_code(conn, prefix: str, digits: int = 6, sep: str = "-") -> str:
    """APT-000042, or UH00000042 with sep=''."""
    n = await next_seq(conn, f"code:{prefix}")
    return f"{prefix}{sep}{n:0{digits}d}"


def render_pattern(pattern: str, *, prefix: str, branch_no: int, at) -> tuple[str, int]:
    """Render every token except the sequence (left as '#'); returns (template, seq digits)."""
    from .spec import CODE_SEQ_RE

    fy = at.year if at.month >= 4 else at.year - 1  # Indian financial year: April–March
    values = {
        "prefix": prefix, "branch": f"{int(branch_no or 1):02d}", "yy": f"{at:%y}", "yyyy": f"{at:%Y}",
        "mm": f"{at:%m}", "fy": f"{fy % 100:02d}{(fy + 1) % 100:02d}",
    }
    digits = int(CODE_SEQ_RE.search(pattern).group(1))
    out = CODE_SEQ_RE.sub("#", pattern)
    for k, v in values.items():
        out = out.replace("{" + k + "}", v)
    return out, digits


async def next_pattern_code(conn, pattern: str, *, prefix: str, branch_no: int, at) -> str:
    """Structured numbers, e.g. "{branch}IP{yy}{mm}{seq:5}" → 01IP261000053. The sequence key is the
    rendered template, so numbering restarts per branch and per period automatically."""
    template, digits = render_pattern(pattern, prefix=prefix, branch_no=branch_no, at=at)
    n = await next_seq(conn, f"code:{prefix}:{template}")
    return template.replace("#", f"{n:0{digits}d}", 1)
