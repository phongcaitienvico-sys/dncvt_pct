"""Kiểm thử scripts/import_payments.py (import lịch sử Đề nghị thanh toán từ Sheet .xlsx)."""
from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

import openpyxl
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import import_payments as imp  # noqa: E402

REAL_SAMPLE = ROOT / "samples" / "QL_De_nghi_thanh_toan.xlsx"


def _make_xlsx(path: Path, rows: list[tuple], catalog: list[tuple]) -> Path:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = imp.SHEET_NAME
    ws.cell(1, 3, "Ngày giờ hiện tại:")
    ws.cell(1, 4, dt.datetime(2026, 11, 2, 8, 0))
    headers = ["STT", "Ngày", "Nội dung", "Số tiền (đồng)", "Người đặt hàng", "Người lấy hàng", "Chức vụ",
               "Đơn vị công tác", "Đơn vị cung cấp hàng", "SĐT nhà xe", "Biển số xe", "Thời gian nhận hàng",
               "Địa điểm nhận hàng", "Sô hiệu đề nghị", "Người lấy hàng", "Chức vụ", "Đơn vị công tác"]
    for i, h in enumerate(headers, 1):
        ws.cell(2, i, h)
    r = 3
    for i, data in enumerate(rows):
        # data: (date, content, amount, orderer, requester, supplier, phone, plate, rtime, rplace, code)
        date, content, amount, orderer, requester, supplier, phone, plate, rtime, rplace, code = data
        vals = {2: date, 3: content, 4: amount, 5: orderer, 6: requester, 9: supplier, 10: phone,
                11: plate, 12: rtime, 13: rplace, 14: code}
        ws.cell(r, 1, i + 1)
        for c, v in vals.items():
            ws.cell(r, c, v)
        r += 1
    # Một dòng trống ở giữa + dòng chỉ có STT -> bỏ qua
    ws.cell(r + 1, 1, 999)
    for i, (name, pos, unit) in enumerate(catalog):
        ws.cell(3 + i, 15, name)
        ws.cell(3 + i, 16, pos)
        ws.cell(3 + i, 17, unit)
    wb.save(path)
    return path


CATALOG = [
    ("Trần Việt Tiệp", "Trưởng phòng", "P. Cải tiến"),
    ("Hoàng Ngọc Hà", "Nhân viên", "P. Cải tiến"),
    ("Chưa TT", None, None),
]

ROWS = [
    (dt.datetime(2025, 1, 6, 14, 35), "Cước xe A", 100000.0, "Tiệp", "Hoàng Ngọc Hà", "NCC 1", "0912", "18C", "9h", "Cổng", "DN2025-001"),
    (dt.datetime(2025, 1, 5), "Cước xe B", 70000, "Tiệp", "Hoàng Ngọc Hà", None, None, None, None, None, "DN2025-001"),
    (dt.datetime(2025, 3, 1), "In tài liệu 'đặc biệt'", 40000.0, "Hà", "Trần Việt Tiệp", None, None, None, None, None, "dn2025-002"),
    (dt.datetime(2026, 9, 1), "Mua dây", 15000.0, "Hà", "Trần Việt Tiệp", None, None, None, None, None, "DN2026-007"),
    (dt.datetime(2026, 10, 20), "Mua AI", 610000.0, "Tiệp", "Trần Việt Tiệp", None, None, None, None, None, "DN2026-009"),
    (dt.datetime(2026, 11, 2), "Mua AI 2", None, "Tiệp", "Người lạ", None, None, None, None, None, "DN2026-009"),
    (dt.datetime(2024, 5, 5), "Phiếu cũ lạ", 5000.0, "Tiệp", "Hoàng Ngọc Hà", None, None, None, None, None, "TT-05"),
]


@pytest.fixture()
def sample(tmp_path: Path) -> Path:
    return _make_xlsx(tmp_path / "sample.xlsx", ROWS, CATALOG)


def test_parse_groups_lines_into_requests(sample: Path):
    data = imp.load_workbook_data(sample)
    assert len(data.lines) == 7
    assert [p["name"] for p in data.payers] == ["Trần Việt Tiệp", "Hoàng Ngọc Hà"]  # bỏ 'Chưa TT'
    reqs = {r["code"]: r for r in data.requests}
    assert set(reqs) == {"DN2025-001", "DN2025-002", "DN2026-007", "DN2026-009", "TT-05"}

    r1 = reqs["DN2025-001"]
    assert (r1["year"], r1["seq"], r1["legacy_flag"]) == (2025, 1, False)
    assert r1["issued_date"] == "2025-01-05"  # ngày nhỏ nhất
    assert r1["line_count"] == 2
    assert r1["total"] == 170000
    assert r1["header"] == {"requester": "Hoàng Ngọc Hà", "position": "Nhân viên", "unit": "P. Cải tiến"}
    assert r1["paid"] is True

    assert reqs["DN2025-002"]["header"]["position"] == "Trưởng phòng"
    # 60 ngày gần nhất so với ngày mới nhất trong file (2026-11-02) -> chưa thanh toán
    assert reqs["DN2026-007"]["paid"] is True   # 2026-09-01 cũ hơn 60 ngày
    assert reqs["DN2026-009"]["paid"] is False  # 2026-10-20
    assert reqs["DN2026-009"]["total"] == 610000
    assert reqs["TT-05"]["legacy_flag"] is True
    assert reqs["TT-05"]["year"] == 2024

    line = next(l for l in data.lines if l["content"] == "Cước xe A")
    assert line == {
        "row": 3, "request_code": "DN2025-001", "pay_date": "2025-01-06", "content": "Cước xe A",
        "amount": 100000, "orderer": "Tiệp", "requester": "Hoàng Ngọc Hà", "supplier": "NCC 1",
        "driver_phone": "0912", "plate_no": "18C", "receive_time": "9h", "receive_place": "Cổng",
        "legacy_flag": False,
    }
    assert next(l for l in data.lines if l["content"].startswith("In tài liệu"))["request_code"] == "DN2025-002"
    # cảnh báo: thiếu số tiền + người đề nghị không có trong danh mục + mã không chuẩn
    joined = "\n".join(data.warnings)
    assert "thiếu số tiền" in joined
    assert "Người lạ" in joined
    assert "TT-05" in joined


def test_report_numbers(sample: Path):
    data = imp.load_workbook_data(sample)
    rep = imp.format_report(data)
    assert "Số dòng: 7" in rep
    assert "Tổng tiền: 840.000" in rep
    assert "Số giấy đề nghị: 5" in rep
    assert "2025: 2 giấy" in rep
    assert "Số lớn nhất: DN2026-009" in rep


def test_dry_run_writes_nothing(sample: Path, tmp_path: Path, capsys):
    out_dir = tmp_path / "out"
    imp.main([str(sample), "--dry-run", "--out-dir", str(out_dir)])
    assert not out_dir.exists()
    assert "Số dòng: 7" in capsys.readouterr().out


def test_sql_output_idempotent_in_pglite(sample: Path, tmp_path: Path):
    out_dir = tmp_path / "out"
    imp.main([str(sample), "--out-dir", str(out_dir)])
    sql_path = out_dir / "payments_import.sql"
    assert sql_path.exists()
    assert (out_dir / "payments_import_report.txt").exists()
    sql = sql_path.read_text(encoding="utf-8")
    assert "\nBEGIN;\n" in sql
    assert sql.rstrip().endswith("COMMIT;")

    pglite = ROOT / "node_modules" / "@electric-sql" / "pglite"
    if not pglite.exists():
        pytest.skip("Không có @electric-sql/pglite")
    runner = tmp_path / "run.js"
    runner.write_text(
        f"""
        const {{ createSupabaseBackend }} = require({json.dumps(str(ROOT / 'dev' / 'supabase_pglite.js'))});
        const fs = require('fs');
        (async () => {{
          const b = await createSupabaseBackend();
          await b.reset();
          await b.setNow('2026-11-03T08:00:00+07:00');
          const sql = fs.readFileSync({json.dumps(str(sql_path))}, 'utf8');
          await b.db.exec(sql);
          await b.db.exec(sql); // chạy lại không nhân đôi
          const q = async (s) => (await b.sqlAsService(s)).rows;
          const counts = (await q(`SELECT (SELECT count(*)::int FROM public.payment_lines) AS l,
                                          (SELECT count(*)::int FROM public.payment_requests) AS r,
                                          (SELECT SUM(amount)::float8 FROM public.payment_lines) AS s`))[0];
          const reqs = await q(`SELECT code, year, seq, line_count, total::float8 AS total, paid, paid_date,
                                       header_json, legacy_flag, to_char(issued_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS d
                                FROM public.payment_requests ORDER BY code`);
          const seqs = await q(`SELECT key, last_value::int AS v FROM public.sequences WHERE key LIKE 'DN%' ORDER BY key`);
          const quote = (await q(`SELECT content FROM public.payment_lines WHERE content LIKE 'In tài liệu%'`))[0].content;
          const {{ adminPassword }} = await b.setup();
          const admin = (await b.call('login', {{ username: 'admin', password: adminPassword }})).token;
          const [line] = await b.call('payments.create', {{ rows: [{{ content: 'Mới', amount: 1 }}] }}, admin);
          const issued = await b.call('payreq.issue', {{ line_ids: [line.id], header: {{ requester: 'Trần Việt Tiệp' }} }}, admin);
          const got = await b.call('payreq.get', {{ codes: ['DN2025-001'] }}, admin);
          await b.close();
          console.log(JSON.stringify({{ counts, reqs, seqs, quote, issued: issued.code, got }}));
        }})().catch((e) => {{ console.error(e); process.exit(1); }});
        """,
        encoding="utf-8",
    )
    proc = subprocess.run(["node", str(runner)], capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert proc.returncode == 0, proc.stderr
    res = json.loads(proc.stdout.strip().splitlines()[-1])
    assert res["counts"] == {"l": 7, "r": 5, "s": 840000}
    reqs = {r["code"]: r for r in res["reqs"]}
    assert reqs["DN2025-001"]["line_count"] == 2
    assert reqs["DN2025-001"]["total"] == 170000
    assert reqs["DN2025-001"]["d"] == "2025-01-05"
    assert reqs["DN2025-001"]["paid"] is True
    assert reqs["DN2025-001"]["paid_date"] is None
    assert reqs["DN2025-001"]["header_json"]["position"] == "Nhân viên"
    assert reqs["DN2026-009"]["paid"] is False
    assert reqs["TT-05"]["legacy_flag"] is True
    # 2026: ít nhất 15 (mốc seed của app) dù số import lớn nhất chỉ là 009; mã lạ (TT-05) không tạo sequence
    assert res["seqs"] == [{"key": "DN2025", "v": 2}, {"key": "DN2026", "v": 15}]
    assert res["quote"] == "In tài liệu 'đặc biệt'"
    # 2026 vẫn bắt đầu từ 016 (seed 15 > max import 9)
    assert res["issued"] == "DN2026-016"
    assert [l["content"] for l in res["got"][0]["lines"]] == ["Cước xe B", "Cước xe A"]


@pytest.mark.skipif(not REAL_SAMPLE.exists(), reason="Không có file mẫu thật")
def test_real_sample_reconciles():
    data = imp.load_workbook_data(REAL_SAMPLE)
    assert len(data.lines) == 142
    assert data.max_code == "DN2026-015"
    assert len(data.payers) == 6
    assert not data.errors


def test_loose_lines_and_all_null_columns_idempotent(tmp_path: Path):
    """Dòng chưa có số hiệu + giấy mà mọi dòng đều trống số tiền/ngày vẫn ra SQL hợp lệ, chạy lại không nhân đôi."""
    rows = [
        (dt.datetime(2026, 1, 2), "Chưa xuất", 1000.0, "Tiệp", "Hoàng Ngọc Hà", None, None, None, None, None, None),
        (dt.datetime(2026, 1, 3), "Chưa xuất 2", None, None, None, None, None, None, None, None, None),
        (dt.datetime(2026, 1, 4), "Không tiền", None, None, "Hoàng Ngọc Hà", None, None, None, None, None, "DN2026-002"),
    ]
    src = _make_xlsx(tmp_path / "loose.xlsx", rows, CATALOG)
    out_dir = tmp_path / "out"
    imp.main([str(src), "--out-dir", str(out_dir)])
    sql_path = out_dir / "payments_import.sql"
    pglite = ROOT / "node_modules" / "@electric-sql" / "pglite"
    if not pglite.exists():
        pytest.skip("Không có @electric-sql/pglite")
    runner = tmp_path / "run.js"
    runner.write_text(
        f"""
        const {{ createSupabaseBackend }} = require({json.dumps(str(ROOT / 'dev' / 'supabase_pglite.js'))});
        const fs = require('fs');
        (async () => {{
          const b = await createSupabaseBackend();
          await b.reset();
          const sql = fs.readFileSync({json.dumps(str(sql_path))}, 'utf8');
          await b.db.exec(sql);
          await b.db.exec(sql);
          const r = (await b.db.query(`SELECT (SELECT count(*)::int FROM public.payment_lines) AS l,
            (SELECT count(*)::int FROM public.payment_lines WHERE request_code IS NULL) AS loose,
            (SELECT total::float8 FROM public.payment_requests WHERE code = 'DN2026-002') AS t,
            (SELECT count(*)::int FROM public.payers) AS p`)).rows[0];
          await b.close();
          console.log(JSON.stringify(r));
        }})().catch((e) => {{ console.error(e); process.exit(1); }});
        """,
        encoding="utf-8",
    )
    proc = subprocess.run(["node", str(runner)], capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    assert proc.returncode == 0, proc.stderr
    res = json.loads(proc.stdout.strip().splitlines()[-1])
    # payers: 6 seed sẵn trong migration, 2 người trong file đều đã có -> không thêm
    assert res == {"l": 3, "loose": 2, "t": 0, "p": 6}
