from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Iterable

from tools.market_data.tdx_hfq import MarketDataError, parse_tdx_hfq_file


PROJECT_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = PROJECT_ROOT / "migrations" / "market"


def connect_market_database(path: str | Path) -> sqlite3.Connection:
    database = sqlite3.connect(path)
    database.row_factory = sqlite3.Row
    database.execute("PRAGMA foreign_keys = ON")
    database.execute("PRAGMA journal_mode = WAL")
    apply_migrations(database)
    return database


def apply_migrations(database: sqlite3.Connection, directory: Path = MIGRATIONS_DIR) -> None:
    database.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations "
        "(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    applied = {row[0] for row in database.execute("SELECT version FROM schema_migrations")}
    for migration in sorted(directory.glob("*.sql")):
        if migration.name in applied:
            continue
        with database:
            database.executescript(migration.read_text(encoding="utf-8"))
            database.execute("INSERT INTO schema_migrations(version) VALUES (?)", (migration.name,))


def import_hfq_file(database: sqlite3.Connection, path: str | Path) -> dict:
    source = Path(path)
    parsed = parse_tdx_hfq_file(source)
    identity = parsed["identity"]
    records = parsed["records"]
    if identity["market"] == "UNKNOWN":
        raise MarketDataError("UNKNOWN_MARKET", f"{identity['stock_code']}不属于已支持市场")

    stock_values = (
        identity["stock_code"], identity["stock_name"], identity["market"], identity["board_type"],
        int(identity["is_st"]), records[0]["tradeDate"], records[-1]["tradeDate"], len(records),
        str(source), source.stat().st_mtime_ns,
    )
    bar_values = [(
        record["stockCode"], record["tradeDate"], record["openCents"], record["highCents"],
        record["lowCents"], record["closeCents"], record["volume"], record["amountCents"],
        record["pctChg"], int(record["isSuspended"]), record["limitUpPriceCents"],
        record["limitDownPriceCents"],
    ) for record in records]

    with database:
        database.execute("""
            INSERT INTO stocks (
              stock_code, stock_name, market, board_type, is_st, adjust_type,
              first_trade_date, last_trade_date, bar_count, source_file, source_mtime_ns
            ) VALUES (?, ?, ?, ?, ?, 'hfq', ?, ?, ?, ?, ?)
            ON CONFLICT(stock_code) DO UPDATE SET
              stock_name = excluded.stock_name,
              market = excluded.market,
              board_type = excluded.board_type,
              is_st = excluded.is_st,
              adjust_type = excluded.adjust_type,
              first_trade_date = excluded.first_trade_date,
              last_trade_date = excluded.last_trade_date,
              bar_count = excluded.bar_count,
              source_file = excluded.source_file,
              source_mtime_ns = excluded.source_mtime_ns,
              imported_at = CURRENT_TIMESTAMP
        """, stock_values)
        database.execute("DELETE FROM daily_bars WHERE stock_code = ?", (identity["stock_code"],))
        database.executemany("""
            INSERT INTO daily_bars (
              stock_code, trade_date, open_cents, high_cents, low_cents, close_cents,
              volume, amount_cents, pct_chg, is_suspended,
              limit_up_price_cents, limit_down_price_cents
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, bar_values)
    return {
        "stockCode": identity["stock_code"],
        "stockName": identity["stock_name"],
        "records": len(records),
        "duplicateRowsSkipped": parsed["duplicateRowsSkipped"],
    }


def read_manifest(path: Path) -> Iterable[Path]:
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#"):
            yield Path(line)


def main() -> int:
    parser = argparse.ArgumentParser(description="导入通达信后复权日线到独立market.db")
    parser.add_argument("--database", type=Path, required=True, help="目标SQLite数据库")
    parser.add_argument("--file", type=Path, action="append", default=[], help="可重复指定的行情文件")
    parser.add_argument("--manifest", type=Path, help="UTF-8文件清单，每行一个完整路径")
    parser.add_argument("--directory", type=Path, help="批量导入目录下的行情文件")
    parser.add_argument("--pattern", default="*.txt", help="配合--directory使用的文件匹配，默认*.txt")
    parser.add_argument("--progress-every", type=int, default=100, help="每处理多少个文件输出一次进度")
    parser.add_argument("--summary-only", action="store_true", help="只输出汇总，不输出逐文件成功记录")
    args = parser.parse_args()
    files = list(args.file)
    if args.manifest:
        files.extend(read_manifest(args.manifest))
    if args.directory:
        files.extend(sorted(path for path in args.directory.glob(args.pattern) if path.is_file()))
    if not files:
        parser.error("至少指定一个--file、--manifest或--directory")

    args.database.parent.mkdir(parents=True, exist_ok=True)
    database = connect_market_database(args.database)
    report = {"database": str(args.database), "imported": [], "failed": []}
    try:
        for index, source in enumerate(files, start=1):
            try:
                report["imported"].append(import_hfq_file(database, source))
            except (MarketDataError, OSError, sqlite3.Error) as error:
                report["failed"].append({
                    "path": str(source),
                    "code": getattr(error, "code", type(error).__name__),
                    "message": str(error),
                    "issues": [issue.__dict__ for issue in getattr(error, "issues", [])],
                })
            if args.progress_every > 0 and (index % args.progress_every == 0 or index == len(files)):
                print(f"已处理 {index}/{len(files)}，失败 {len(report['failed'])}", file=sys.stderr, flush=True)
    finally:
        database.close()
    output = report if not args.summary_only else {
        "database": report["database"], "total": len(files),
        "imported": len(report["imported"]), "failed": report["failed"],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if report["imported"] and not report["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
