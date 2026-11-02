#!/usr/bin/env python3
"""Import lịch sử "Đề nghị thanh toán" từ file .xlsx tải về từ Google Sheet.

Đọc sheet "QLde nghi thanh toan" (tiêu đề ở dòng 2, dữ liệu từ dòng 3):
  B Ngày | C Nội dung | D Số tiền | E Người đặt hàng | F Người lấy hàng (→ requester)
  I NCC | J SĐT nhà xe | K Biển số | L Thời gian nhận | M Địa điểm nhận | N Số hiệu đề nghị
  O:Q  = danh mục người đề nghị (Họ tên / Chức vụ / Đơn vị), bỏ qua "Chưa TT".

Gom dòng theo số hiệu thành giấy đề nghị (giữ nguyên số cũ), rồi:
  --dry-run : chỉ in báo cáo đối soát (số dòng, tổng tiền, số giấy theo năm, lỗi/cảnh báo)
  mặc định  : ghi out/payments_import.sql (idempotent: chạy lại không nhân đôi) +
              out/payments_import_report.txt

Quy ước:
  - Mã hợp lệ DN<yyyy>-<nnn> → legacy_flag=false, year/seq lấy từ mã; mã khác → legacy_flag=true, seq=0.
  - issued_at = ngày nhỏ nhất của các dòng (00:00 giờ VN); header lấy theo người lấy hàng của dòng đầu,
    chức vụ/đơn vị tra trong danh mục O:Q (không có thì lấy cột G/H của dòng đó).
  - Giấy cũ: paid=true, paid_date=null. Giấy xuất trong 60 ngày gần nhất (so với ngày mới nhất trong file):
    paid=false.
  - Sequence 'DN'||năm được nâng lên ít nhất bằng số lớn nhất đã import (năm 2026 tối thiểu 15).
  - SQL: giấy đề nghị ON CONFLICT (code) DO NOTHING; dòng của một giấy chỉ chèn khi giấy đó chưa có dòng nào
    (nên không ghi đè chỉnh sửa/thanh toán đã làm trên app); cuối cùng tính lại line_count/total.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import unicodedata
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "samples" / "QL_De_nghi_thanh_toan.xlsx"
DEFAULT_OUT_DIR = ROOT / "out"
SHEET_NAME = "QLde nghi thanh toan"
HEADER_ROW = 2
FIRST_DATA_ROW = 3
IMPORT_BY = "Nhập từ Sheet"
UNPAID_WINDOW_DAYS = 60
# Mốc seed sequence của app (rpc_payreq_issue): 2026 bắt đầu từ 15 → DN2026-016
SEQ_SEED = {2026: 15}
CODE_RE = re.compile(r"^DN(\d{4})-(\d{3,})$")

# Cột (1-based)
C_DATE, C_CONTENT, C_AMOUNT, C_ORDERER, C_REQUESTER = 2, 3, 4, 5, 6
C_POSITION, C_UNIT = 7, 8
C_SUPPLIER, C_PHONE, C_PLATE, C_RTIME, C_RPLACE, C_CODE = 9, 10, 11, 12, 13, 14
C_CAT_NAME, C_CAT_POS, C_CAT_UNIT = 15, 16, 17


@dataclass
class ImportData:
    source: str = ""
    lines: list[dict[str, Any]] = field(default_factory=list)
    requests: list[dict[str, Any]] = field(default_factory=list)
    payers: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    newest_date: str | None = None
    max_code: str | None = None


# ---------------------------------------------------------------------------
# Chuẩn hóa giá trị ô
# ---------------------------------------------------------------------------
def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def clean_str(v: Any) -> str | None:
    if _blank(v):
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, dt.datetime):
        s = v.strftime("%d/%m/%Y %H:%M") if (v.hour or v.minute) else v.strftime("%d/%m/%Y")
    elif isinstance(v, dt.date):
        s = v.strftime("%d/%m/%Y")
    elif isinstance(v, dt.time):
        s = v.strftime("%H:%M")
    else:
        s = str(v)
    s = unicodedata.normalize("NFC", s)
    s = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F]", "", s)
    s = s.replace("\u00a0", " ").strip()
    return s or None


def parse_date(v: Any) -> str | None:
    """Trả về 'YYYY-MM-DD' hoặc None nếu trống; ValueError nếu không hiểu."""
    if _blank(v):
        return None
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    s = str(v).strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return dt.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    m = re.match(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})", s)
    if m:
        return dt.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    raise ValueError(f"ngày không hợp lệ: {s!r}")


def parse_amount(v: Any) -> int | float | None:
    if _blank(v):
        return None
    if isinstance(v, bool):
        raise ValueError(f"số tiền không hợp lệ: {v!r}")
    if isinstance(v, (int, float)):
        n = float(v)
    else:
        s = str(v).strip().replace(" ", "").replace("\u00a0", "")
        s = re.sub(r"(đ|đồng|vnd)$", "", s, flags=re.I)
        if re.fullmatch(r"\d{1,3}([.,]\d{3})+", s):
            s = re.sub(r"[.,]", "", s)
        else:
            s = s.replace(",", ".")
        try:
            n = float(s)
        except ValueError:
            raise ValueError(f"số tiền không hợp lệ: {v!r}") from None
    if n < 0:
        raise ValueError(f"số tiền âm: {v!r}")
    return int(n) if n.is_integer() else round(n, 3)


def name_key(s: str | None) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s or "")).strip().lower()


def fmt_money(n: float | int) -> str:
    n = int(round(n)) if float(n).is_integer() else n
    if isinstance(n, int):
        return f"{n:,}".replace(",", ".")
    return f"{n:,.3f}".replace(",", "_").replace(".", ",").replace("_", ".")


# ---------------------------------------------------------------------------
# Đọc workbook
# ---------------------------------------------------------------------------
def load_workbook_data(path: Path | str) -> ImportData:
    path = Path(path)
    data = ImportData(source=path.name)
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    if SHEET_NAME not in wb.sheetnames:
        raise ValueError(f"Không thấy sheet {SHEET_NAME!r} trong {path.name} (có: {wb.sheetnames})")
    ws = wb[SHEET_NAME]

    raw_rows: list[tuple[int, tuple]] = []
    for idx, row in enumerate(ws.iter_rows(min_row=FIRST_DATA_ROW, max_col=17, values_only=True), FIRST_DATA_ROW):
        row = tuple(row) + (None,) * (17 - len(row))
        raw_rows.append((idx, row))
    wb.close()

    # Danh mục người đề nghị O:Q
    seen: set[str] = set()
    catalog: dict[str, dict[str, Any]] = {}
    for _, row in raw_rows:
        name = clean_str(row[C_CAT_NAME - 1])
        if not name or name_key(name) == "chưa tt":
            continue
        k = name_key(name)
        if k in seen:
            continue
        seen.add(k)
        p = {"name": name, "position": clean_str(row[C_CAT_POS - 1]), "unit": clean_str(row[C_CAT_UNIT - 1])}
        data.payers.append(p)
        catalog[k] = p

    # Dòng thanh toán
    line_extra: dict[int, dict[str, Any]] = {}
    for idx, row in raw_rows:
        cells = row[C_DATE - 1:C_CODE]
        if all(_blank(v) for v in cells):
            continue
        try:
            pay_date = parse_date(row[C_DATE - 1])
        except ValueError as e:
            data.errors.append(f"Dòng {idx}: {e}")
            pay_date = None
        try:
            amount = parse_amount(row[C_AMOUNT - 1])
        except ValueError as e:
            data.errors.append(f"Dòng {idx}: {e}")
            amount = None
        code_raw = clean_str(row[C_CODE - 1])
        code = code_raw.upper().replace(" ", "") if code_raw else None
        legacy = bool(code) and not CODE_RE.match(code)
        line = {
            "row": idx,
            "request_code": code,
            "pay_date": pay_date,
            "content": clean_str(row[C_CONTENT - 1]),
            "amount": amount,
            "orderer": clean_str(row[C_ORDERER - 1]),
            "requester": clean_str(row[C_REQUESTER - 1]),
            "supplier": clean_str(row[C_SUPPLIER - 1]),
            "driver_phone": clean_str(row[C_PHONE - 1]),
            "plate_no": clean_str(row[C_PLATE - 1]),
            "receive_time": clean_str(row[C_RTIME - 1]),
            "receive_place": clean_str(row[C_RPLACE - 1]),
            "legacy_flag": legacy,
        }
        line_extra[idx] = {"position": clean_str(row[C_POSITION - 1]), "unit": clean_str(row[C_UNIT - 1])}
        if amount is None and not any(e.startswith(f"Dòng {idx}:") for e in data.errors):
            data.warnings.append(f"Dòng {idx}: thiếu số tiền ({line['content'] or ''}) — nhập với số tiền trống")
        if pay_date is None and not any(e.startswith(f"Dòng {idx}:") for e in data.errors):
            data.warnings.append(f"Dòng {idx}: thiếu ngày")
        if not line["content"]:
            data.warnings.append(f"Dòng {idx}: thiếu nội dung")
        if line["requester"] and name_key(line["requester"]) not in catalog:
            data.warnings.append(f"Dòng {idx}: người lấy hàng {line['requester']!r} không có trong danh mục O:Q")
        if not code:
            data.warnings.append(f"Dòng {idx}: chưa có số hiệu đề nghị — nhập thành dòng chưa xuất giấy")
        data.lines.append(line)

    dates = [l["pay_date"] for l in data.lines if l["pay_date"]]
    data.newest_date = max(dates) if dates else None
    cutoff = None
    if data.newest_date:
        cutoff = (dt.date.fromisoformat(data.newest_date) - dt.timedelta(days=UNPAID_WINDOW_DAYS)).isoformat()

    # Gom theo số hiệu
    groups: "OrderedDict[str, list[dict[str, Any]]]" = OrderedDict()
    for l in data.lines:
        if l["request_code"]:
            groups.setdefault(l["request_code"], []).append(l)

    best: tuple[int, int] | None = None
    for code, ls in groups.items():
        m = CODE_RE.match(code)
        ldates = [l["pay_date"] for l in ls if l["pay_date"]]
        issued = min(ldates) if ldates else None
        if m:
            year, seq, legacy = int(m[1]), int(m[2]), False
            if best is None or (year, seq) > best:
                best = (year, seq)
                data.max_code = code
        else:
            legacy = True
            seq = 0
            year = int(issued[:4]) if issued else 0
            data.warnings.append(f"Số hiệu {code!r} không đúng mẫu DNyyyy-nnn — nhập là giấy lịch sử (legacy)")
        if issued is None:
            data.errors.append(f"Giấy {code}: không dòng nào có ngày")
        first = ls[0]
        req_name = first["requester"] or ""
        cat = catalog.get(name_key(req_name))
        extra = line_extra.get(first["row"], {})
        header = {
            "requester": req_name,
            "position": (cat or {}).get("position") or extra.get("position") or "",
            "unit": (cat or {}).get("unit") or extra.get("unit") or "",
        }
        total = sum(float(l["amount"] or 0) for l in ls)
        total = int(total) if float(total).is_integer() else round(total, 3)
        paid = not (cutoff is not None and issued is not None and issued >= cutoff)
        data.requests.append({
            "code": code,
            "year": year,
            "seq": seq,
            "legacy_flag": legacy,
            "issued_date": issued,
            "header": header,
            "line_count": len(ls),
            "total": total,
            "paid": paid,
        })
    return data


# ---------------------------------------------------------------------------
# Báo cáo
# ---------------------------------------------------------------------------
def format_report(data: ImportData) -> str:
    total = sum(float(l["amount"] or 0) for l in data.lines)
    per_year: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for r in data.requests:
        per_year[r["year"]].append(r)
    unpaid = [r["code"] for r in data.requests if not r["paid"]]
    out = [
        "BÁO CÁO ĐỐI SOÁT IMPORT ĐỀ NGHỊ THANH TOÁN",
        f"Nguồn: {data.source} / sheet {SHEET_NAME!r}",
        f"Số dòng: {len(data.lines)}",
        f"Tổng tiền: {fmt_money(total)} đồng",
        f"Số giấy đề nghị: {len(data.requests)}",
        f"Dòng chưa có số hiệu: {sum(1 for l in data.lines if not l['request_code'])}",
        f"Ngày mới nhất trong file: {data.newest_date or '-'}",
        f"Số lớn nhất: {data.max_code or '-'}",
        f"Danh mục người đề nghị (O:Q): {len(data.payers)} — " + ", ".join(p["name"] for p in data.payers),
        "Theo năm:",
    ]
    for y in sorted(per_year):
        rs = per_year[y]
        s = sum(float(r["total"]) for r in rs)
        n_lines = sum(r["line_count"] for r in rs)
        out.append(f"  {y}: {len(rs)} giấy, {n_lines} dòng, {fmt_money(s)} đồng")
    out.append(
        f"Chưa thanh toán (xuất trong {UNPAID_WINDOW_DAYS} ngày gần nhất): {len(unpaid)}"
        + (" — " + ", ".join(unpaid) if unpaid else "")
    )
    out.append(f"Lỗi: {len(data.errors)}")
    out.extend("  - " + e for e in data.errors)
    out.append(f"Cảnh báo: {len(data.warnings)}")
    out.extend("  - " + w for w in data.warnings)
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# Sinh SQL idempotent
# ---------------------------------------------------------------------------
def sql_literal(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v) if isinstance(v, int) else (str(int(v)) if float(v).is_integer() else repr(v))
    if isinstance(v, (dict, list)):
        return sql_literal(json.dumps(v, ensure_ascii=False)) + "::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


def _ts(d: str | None) -> str:
    return "NULL::timestamptz" if not d else f"'{d} 00:00:00+07'::timestamptz"


def _date(d: str | None) -> str:
    return "NULL::date" if not d else f"'{d}'::date"


def _amount(a: Any) -> str:
    return "NULL::numeric" if a is None else f"{sql_literal(a)}::numeric"


LINE_COLS = (
    "request_code, pay_date, content, amount, orderer, requester, supplier, driver_phone, plate_no, "
    "receive_time, receive_place, note, legacy_flag, created_by, created_at, updated_at"
)


def _line_values(l: dict[str, Any]) -> str:
    return "(" + ", ".join([
        sql_literal(l["request_code"]) + "::text",
        _date(l["pay_date"]),
        sql_literal(l["content"]),
        _amount(l["amount"]),
        sql_literal(l["orderer"]),
        sql_literal(l["requester"]),
        sql_literal(l["supplier"]),
        sql_literal(l["driver_phone"]),
        sql_literal(l["plate_no"]),
        sql_literal(l["receive_time"]),
        sql_literal(l["receive_place"]),
        "NULL",
        sql_literal(l["legacy_flag"]),
        sql_literal(IMPORT_BY),
        _ts(l["pay_date"]),
        _ts(l["pay_date"]),
    ]) + ")"


def generate_sql(data: ImportData) -> str:
    out: list[str] = [
        "-- Sinh tự động bởi scripts/import_payments.py từ " + data.source,
        "-- Chạy SAU migration 002_payments.sql. Idempotent: chạy lại không nhân đôi dữ liệu.",
        "BEGIN;",
        "",
        "-- 1. Danh mục người đề nghị (chỉ thêm người chưa có)",
    ]
    for p in data.payers:
        out.append(
            "INSERT INTO public.payers (name, position, unit) SELECT "
            f"{sql_literal(p['name'])}, {sql_literal(p['position'])}, {sql_literal(p['unit'])} "
            "WHERE NOT EXISTS (SELECT 1 FROM public.payers WHERE lower(btrim(name)) = lower(btrim("
            f"{sql_literal(p['name'])})));"
        )

    out += ["", "-- 2. Giấy đề nghị (giữ nguyên số cũ; đã có thì bỏ qua)"]
    for r in data.requests:
        out.append(
            "INSERT INTO public.payment_requests (code, year, seq, issued_at, issued_by, header_json, line_count, total, "
            "paid, paid_date, paid_by, legacy_flag) VALUES ("
            + ", ".join([
                sql_literal(r["code"]), str(r["year"]), str(r["seq"]), _ts(r["issued_date"]), sql_literal(IMPORT_BY),
                sql_literal(r["header"]), str(r["line_count"]), f"{sql_literal(r['total'])}::numeric",
                sql_literal(r["paid"]), "NULL", "NULL", sql_literal(r["legacy_flag"]),
            ])
            + ") ON CONFLICT (code) DO NOTHING;"
        )

    out += ["", "-- 3. Dòng thanh toán của từng giấy (chỉ chèn khi giấy chưa có dòng nào)"]
    by_code: "OrderedDict[str, list[dict[str, Any]]]" = OrderedDict()
    for l in data.lines:
        if l["request_code"]:
            by_code.setdefault(l["request_code"], []).append(l)
    for code, ls in by_code.items():
        out.append(f"INSERT INTO public.payment_lines ({LINE_COLS})")
        out.append("SELECT v.* FROM (VALUES")
        out.append(",\n".join("  " + _line_values(l) for l in ls))
        out.append(f") AS v({LINE_COLS})")
        out.append(f"WHERE NOT EXISTS (SELECT 1 FROM public.payment_lines x WHERE x.request_code = {sql_literal(code)});")

    loose = [l for l in data.lines if not l["request_code"]]
    if loose:
        out += ["", "-- 4. Dòng chưa có số hiệu (chèn nếu chưa có dòng import giống hệt)"]
        for l in loose:
            out.append(f"INSERT INTO public.payment_lines ({LINE_COLS}) SELECT * FROM (VALUES {_line_values(l)}) AS v({LINE_COLS})")
            out.append(
                "WHERE NOT EXISTS (SELECT 1 FROM public.payment_lines x WHERE x.request_code IS NULL "
                f"AND x.created_by = {sql_literal(IMPORT_BY)} AND x.pay_date IS NOT DISTINCT FROM {_date(l['pay_date'])} "
                f"AND x.content IS NOT DISTINCT FROM {sql_literal(l['content'])}::text AND x.amount IS NOT DISTINCT FROM {_amount(l['amount'])});"
            )

    codes = [r["code"] for r in data.requests]
    if codes:
        code_list = ", ".join(sql_literal(c) for c in codes)
        out += [
            "",
            "-- 5. Tính lại số dòng + tổng tiền theo dòng thực tế",
            "UPDATE public.payment_requests r SET line_count = s.cnt, total = s.total FROM (",
            "  SELECT request_code, count(*)::int AS cnt, COALESCE(SUM(COALESCE(amount, 0)), 0) AS total",
            f"  FROM public.payment_lines WHERE request_code IN ({code_list}) GROUP BY request_code",
            ") s WHERE r.code = s.request_code;",
        ]

    max_seq: dict[int, int] = {}
    for r in data.requests:
        if not r["legacy_flag"]:
            max_seq[r["year"]] = max(max_seq.get(r["year"], 0), r["seq"])
    if max_seq:
        out += ["", "-- 6. Nâng sequence 'DN'||năm lên ít nhất số lớn nhất đã import"]
        for y in sorted(max_seq):
            v = max(max_seq[y], SEQ_SEED.get(y, 0))
            out.append(
                f"INSERT INTO public.sequences (key, last_value) VALUES ('DN{y}', {v}) "
                "ON CONFLICT (key) DO UPDATE SET last_value = GREATEST(public.sequences.last_value, EXCLUDED.last_value);"
            )

    out += ["", "COMMIT;", ""]
    return "\n".join(out)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> ImportData:
    ap = argparse.ArgumentParser(description="Import lịch sử Đề nghị thanh toán từ file .xlsx của Google Sheet")
    ap.add_argument("source", nargs="?", type=Path, default=DEFAULT_SOURCE, help="File .xlsx (mặc định samples/QL_De_nghi_thanh_toan.xlsx)")
    ap.add_argument("--dry-run", action="store_true", help="Chỉ in báo cáo đối soát, không ghi file")
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR, help="Thư mục ghi payments_import.sql + report (mặc định out/)")
    args = ap.parse_args(argv)

    data = load_workbook_data(args.source)
    report = format_report(data)
    try:
        sys.stdout.write(report)
    except UnicodeEncodeError:
        sys.stdout.buffer.write(report.encode("utf-8"))
    sys.stdout.flush()

    if args.dry_run:
        return data
    if data.errors:
        print(f"Có {len(data.errors)} lỗi — KHÔNG ghi file SQL. Sửa dữ liệu nguồn rồi chạy lại.", file=sys.stderr)
        raise SystemExit(1)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    sql_path = args.out_dir / "payments_import.sql"
    rep_path = args.out_dir / "payments_import_report.txt"
    sql_path.write_text(generate_sql(data), encoding="utf-8", newline="\n")
    rep_path.write_text(report, encoding="utf-8", newline="\n")
    print(f"Đã ghi {sql_path} và {rep_path}")
    return data


if __name__ == "__main__":
    main()
