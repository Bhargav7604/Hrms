"""Report exports — CSV, Excel (.xlsx) and PDF — written without extra dependencies.

Only the columns the user chose (in their order) are exported; a totals row is appended for summed
columns. XLSX is a minimal SpreadsheetML package (inline strings, numbers as numbers, bold header and
totals, frozen header row, column widths); PDF is a plain tabular A4-landscape document."""

from __future__ import annotations

import csv
import io
import zipfile
from typing import Any
from xml.sax.saxutils import escape

from ..core.util import now, parse_dt

NUMERIC = {"number", "money", "percent", "minutes", "days"}


def _cell_text(v: Any, typ: str) -> str:
    if v is None or v == "":
        return ""
    if typ == "bool":
        return "Yes" if v in (True, "true", "Yes") else "No"
    if typ == "datetime":
        try:
            return parse_dt(v).strftime("%d-%m-%Y %H:%M")
        except (ValueError, TypeError, AttributeError):
            return str(v)
    if typ == "date":
        s = str(v)[:10]
        return f"{s[8:10]}-{s[5:7]}-{s[0:4]}" if len(s) == 10 and s[4] == "-" else str(v)
    if typ == "money" and isinstance(v, (int, float)):
        return f"{v:,.2f}"
    if isinstance(v, float):
        return f"{v:,.2f}".rstrip("0").rstrip(".") if v != int(v) else f"{int(v):,}"
    return str(v)


def to_csv(columns: list[dict], rows: list[dict], totals: dict | None, title: str, subtitle: str) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([title])
    w.writerow([subtitle])
    w.writerow([])
    w.writerow([c["label"] for c in columns])
    for r in rows:
        w.writerow([("" if r.get(c["key"]) is None else (r[c["key"]] if c["type"] in NUMERIC else _cell_text(r.get(c["key"]), c["type"])))
                    for c in columns])
    if totals:
        w.writerow([("Total" if i == 0 else totals.get(c["key"], "")) for i, c in enumerate(columns)])
    return ("﻿" + buf.getvalue()).encode("utf-8")  # BOM so Excel opens UTF-8 (₹, Indian names) correctly


# ---------------------------------------------------------------- xlsx

def _col_letter(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _xcell(ref: str, v: Any, typ: str, style: int = 0) -> str:
    st = f' s="{style}"' if style else ""
    if v is None or v == "":
        return f'<c r="{ref}"{st}/>'
    if typ in NUMERIC and isinstance(v, (int, float)) and not isinstance(v, bool):
        fmt = 3 if typ == "money" and not style else style
        return f'<c r="{ref}" s="{fmt}"><v>{v}</v></c>' if fmt else f'<c r="{ref}"><v>{v}</v></c>'
    return f'<c r="{ref}" t="inlineStr"{st}><is><t xml:space="preserve">{escape(_cell_text(v, typ))}</t></is></c>'


def to_xlsx(columns: list[dict], rows: list[dict], totals: dict | None, title: str, subtitle: str) -> bytes:
    lines = []
    r = 1
    lines.append(f'<row r="{r}">{_xcell("A1", title, "text", 2)}</row>')
    r += 1
    lines.append(f'<row r="{r}">{_xcell("A2", subtitle, "text")}</row>')
    r += 2
    header_row = r
    lines.append(f'<row r="{r}">' + "".join(_xcell(f"{_col_letter(i)}{r}", c["label"], "text", 1) for i, c in enumerate(columns)) + "</row>")
    for row in rows:
        r += 1
        lines.append(f'<row r="{r}">' + "".join(_xcell(f"{_col_letter(i)}{r}", row.get(c["key"]), c["type"]) for i, c in enumerate(columns)) + "</row>")
    if totals:
        r += 1
        cells = []
        for i, c in enumerate(columns):
            v = "Total" if i == 0 and c["key"] not in totals else totals.get(c["key"])
            cells.append(_xcell(f"{_col_letter(i)}{r}", v, c["type"] if c["key"] in totals else "text", 4 if c["key"] in totals else 1))
        lines.append(f'<row r="{r}">' + "".join(cells) + "</row>")
    widths = []
    for i, c in enumerate(columns):
        longest = max([len(c["label"])] + [len(_cell_text(x.get(c["key"]), c["type"])) for x in rows[:300]])
        widths.append(f'<col min="{i + 1}" max="{i + 1}" width="{min(60, max(8, longest + 2))}" customWidth="1"/>')
    last = _col_letter(max(0, len(columns) - 1))
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f'<sheetViews><sheetView workbookViewId="0"><pane ySplit="{header_row}" topLeftCell="A{header_row + 1}" activePane="bottomLeft" state="frozen"/>'
             '</sheetView></sheetViews>'
             f'<cols>{"".join(widths)}</cols><sheetData>{"".join(lines)}</sheetData>'
             f'<autoFilter ref="A{header_row}:{last}{max(header_row, r - (1 if totals else 0))}"/></worksheet>')
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>'
              '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>'
              '<font><b/><sz val="14"/><name val="Calibri"/></font></fonts>'
              '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
              '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF4F7"/></patternFill></fill></fills>'
              '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>'
              '<cellXfs count="5"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/><xf fontId="2" applyFont="1"/>'
              '<xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="2" applyNumberFormat="1" applyFont="1" applyFill="1"/>'
              '</cellXfs></styleSheet>')
    sheet_name = escape(title[:31].replace("/", "-").replace("\\", "-").replace("?", "").replace("*", "").replace("[", "(").replace("]", ")")) or "Report"
    files = {
        "[Content_Types].xml": ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                                '<Default Extension="xml" ContentType="application/xml"/>'
                                '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                                '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                                '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                                '</Types>'),
        "_rels/.rels": ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                        '</Relationships>'),
        "xl/workbook.xml": ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                            f'<sheets><sheet name="{sheet_name}" sheetId="1" r:id="rId1"/></sheets>'
                            f'<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'{sheet_name}\'!$A${header_row}:${last}${max(header_row, r)}</definedName></definedNames>'
                            '</workbook>'),
        "xl/_rels/workbook.xml.rels": ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                                       '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                                       '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
                                       '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                                       '</Relationships>'),
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": sheet,
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in files.items():
            z.writestr(name, body)
    return out.getvalue()


# ---------------------------------------------------------------- pdf

def _pdf_text(s: str) -> str:
    s = s.replace("₹", "Rs.").replace("–", "-").replace("—", "-").replace("·", "-").replace("≤", "<=").replace("≥", ">=").replace("’", "'")
    s = s.encode("latin-1", "replace").decode("latin-1")
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def to_pdf(columns: list[dict], rows: list[dict], totals: dict | None, title: str, subtitle: str) -> bytes:
    """A4 landscape, Helvetica 7.5pt table with repeated headers and page numbers."""
    W, H, M = 842, 595, 28
    fs, lh = 7.5, 11
    avail = W - 2 * M
    texts = [[_cell_text(r.get(c["key"]), c["type"]) for c in columns] for r in rows]
    if totals:
        texts.append([("Total" if i == 0 and c["key"] not in totals else _cell_text(totals.get(c["key"]), c["type"])) for i, c in enumerate(columns)])
    natural = [max([len(c["label"])] + [len(t[i]) for t in texts[:400]]) + 2 for i, c in enumerate(columns)]
    total_chars = sum(min(n, 40) for n in natural) or 1
    widths = [avail * min(n, 40) / total_chars for n in natural]
    maxch = [max(3, int((w - 4) / (fs * 0.56))) for w in widths]

    def clip(s: str, n: int) -> str:
        return s if len(s) <= n else s[: max(1, n - 2)] + ".."

    per_page = int((H - 2 * M - 70) / lh)
    pages: list[str] = []
    chunks = [texts[i:i + per_page] for i in range(0, max(1, len(texts)), per_page)] or [[]]
    stamp = now().strftime("%d-%m-%Y %H:%M")
    for pi, chunk in enumerate(chunks):
        ops = ["BT", f"/F2 13 Tf {M} {H - M - 4} Td ({_pdf_text(title)}) Tj", "ET",
               "BT", f"/F1 8 Tf {M} {H - M - 18} Td ({_pdf_text(subtitle)}) Tj", "ET"]
        y = H - M - 42
        ops.append(f"0.93 0.95 0.97 rg {M} {y - 3} {avail} {lh} re f 0 g")
        x = M
        for i, c in enumerate(columns):
            ops.append(f"BT /F2 {fs} Tf {x + 2:.1f} {y:.1f} Td ({_pdf_text(clip(c['label'], maxch[i]))}) Tj ET")
            x += widths[i]
        for ri, t in enumerate(chunk):
            y -= lh
            is_total = totals and pi == len(chunks) - 1 and ri == len(chunk) - 1
            font = "/F2" if is_total else "/F1"
            if ri % 2 == 1:
                ops.append(f"0.975 0.98 0.985 rg {M} {y - 3} {avail} {lh} re f 0 g")
            x = M
            for i, c in enumerate(columns):
                s = clip(t[i], maxch[i])
                if c["type"] in NUMERIC:
                    tx = x + widths[i] - 4 - len(s) * fs * 0.53
                else:
                    tx = x + 2
                ops.append(f"BT {font} {fs} Tf {tx:.1f} {y:.1f} Td ({_pdf_text(s)}) Tj ET")
                x += widths[i]
        ops.append(f"BT /F1 7 Tf {M} {M - 12} Td ({_pdf_text(f'Generated {stamp} - page {pi + 1} of {len(chunks)}')}) Tj ET")
        pages.append("\n".join(ops))

    objs: list[bytes] = []

    def add(body: str | bytes) -> int:
        objs.append(body.encode("latin-1") if isinstance(body, str) else body)
        return len(objs)

    f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    pages_id = len(objs) + 1 + 2 * len(pages)
    kids = []
    for content in pages:
        data = content.encode("latin-1", "replace")
        cid = add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream")
        kids.append(add(f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {W} {H}] /Contents {cid} 0 R "
                        f"/Resources << /Font << /F1 {f1} 0 R /F2 {f2} 0 R >> >> >>"))
    assert add(f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>") == pages_id
    cat = add(f"<< /Type /Catalog /Pages {pages_id} 0 R >>")
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for o in offsets:
        out.write(f"{o:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root {cat} 0 R >>\nstartxref\n{xref}\n%%EOF".encode())
    return out.getvalue()


FORMATS = {
    "csv": ("text/csv; charset=utf-8", "csv", to_csv),
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx", to_xlsx),
    "pdf": ("application/pdf", "pdf", to_pdf),
}
