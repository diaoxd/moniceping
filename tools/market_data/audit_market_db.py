from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


REQUIRED_TABLES = {"stocks", "daily_bars"}


def audit_market_database(path: str | Path) -> dict:
    database_path = Path(path)
    report = {
        "database": str(database_path),
        "status": "FAIL",
        "summary": {},
        "quality": {},
        "eligible": {},
        "issues": [],
    }
    if not database_path.is_file():
        report["issues"].append("行情数据库文件不存在")
        return report

    database = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in database.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        missing_tables = sorted(REQUIRED_TABLES - tables)
        if missing_tables:
            report["issues"].append(f"缺少数据表：{', '.join(missing_tables)}")
            return report

        stock_count = database.execute("SELECT COUNT(*) FROM stocks").fetchone()[0]
        bar_count, first_date, last_date = database.execute(
            "SELECT COUNT(*), MIN(trade_date), MAX(trade_date) FROM daily_bars"
        ).fetchone()
        report["summary"] = {
            "stockCount": stock_count,
            "barCount": bar_count,
            "firstTradeDate": first_date,
            "lastTradeDate": last_date,
        }
        quality = {
            "invalidOhlc": database.execute("""
                SELECT COUNT(*) FROM daily_bars
                WHERE high_cents < MAX(open_cents, close_cents)
                   OR low_cents > MIN(open_cents, close_cents)
                   OR high_cents < low_cents
            """).fetchone()[0],
            "negativeVolumeOrAmount": database.execute("""
                SELECT COUNT(*) FROM daily_bars WHERE volume < 0 OR amount_cents < 0
            """).fetchone()[0],
            "orphanBars": database.execute("""
                SELECT COUNT(*) FROM daily_bars d
                LEFT JOIN stocks s ON s.stock_code = d.stock_code
                WHERE s.stock_code IS NULL
            """).fetchone()[0],
            "barCountMismatches": database.execute("""
                SELECT COUNT(*) FROM stocks s
                WHERE s.bar_count != (SELECT COUNT(*) FROM daily_bars d WHERE d.stock_code = s.stock_code)
            """).fetchone()[0],
        }
        report["quality"] = quality
        eligibility_query = """
            WITH ranked AS (
              SELECT stock_code, trade_date,
                     ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY trade_date) AS row_number,
                     COUNT(*) OVER (PARTITION BY stock_code) AS total
              FROM daily_bars
            )
            SELECT COUNT(DISTINCT stock_code) FROM ranked
            WHERE trade_date >= '2021-01-01'
              AND row_number >= 201
              AND total - row_number + 1 >= ?
        """
        report["eligible"] = {
            "simulation150": database.execute(eligibility_query, (150,)).fetchone()[0],
            "simulation200": database.execute(eligibility_query, (200,)).fetchone()[0],
        }
        if stock_count == 0 or bar_count == 0:
            report["issues"].append("行情数据库为空")
        for name, count in quality.items():
            if count:
                report["issues"].append(f"{name}：{count}")
        if report["eligible"]["simulation150"] == 0:
            report["issues"].append("没有满足200根上下文和150根模拟区间的候选")
        if not report["issues"]:
            report["status"] = "PASS"
        return report
    finally:
        database.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="验收随机训练market.db完整性和候选覆盖")
    parser.add_argument("--database", type=Path, required=True, help="只读验收的market.db路径")
    parser.add_argument("--output", type=Path, help="可选JSON报告输出路径")
    args = parser.parse_args()
    report = audit_market_database(args.database)
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
