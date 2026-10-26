from __future__ import annotations

import argparse
import csv
import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Iterable


CENT = Decimal("0.01")


@dataclass(frozen=True)
class StockIdentity:
    stock_code: str
    stock_name: str
    market: str
    board_type: str
    is_st: bool


@dataclass(frozen=True)
class QualityIssue:
    code: str
    message: str
    line_number: int | None = None
    trade_date: str | None = None


class MarketDataError(Exception):
    def __init__(self, code: str, message: str, issues: list[QualityIssue] | None = None):
        super().__init__(message)
        self.code = code
        self.issues = issues or []


def classify_stock(stock_code: str) -> tuple[str, str]:
    if re.fullmatch(r"688\d{3}", stock_code):
        return "SH", "STAR"
    if re.fullmatch(r"6\d{5}", stock_code):
        return "SH", "MAIN"
    if re.fullmatch(r"3\d{5}", stock_code):
        return "SZ", "CHINEXT"
    if re.fullmatch(r"0\d{5}", stock_code):
        return "SZ", "MAIN"
    if re.fullmatch(r"(?:4|8)\d{5}", stock_code) or re.fullmatch(r"92\d{4}", stock_code):
        return "BJ", "BSE"
    return "UNKNOWN", "UNKNOWN"


def _to_cents(value: str, field: str) -> int:
    try:
        amount = Decimal(value.strip())
    except (InvalidOperation, AttributeError) as error:
        raise MarketDataError("INVALID_NUMBER", f"{field}不是有效数字") from error
    if not amount.is_finite() or amount < 0:
        raise MarketDataError("INVALID_NUMBER", f"{field}不能为负数或非有限值")
    return int((amount / CENT).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _to_non_negative_integer(value: str, field: str) -> int:
    try:
        number = Decimal(value.strip())
    except (InvalidOperation, AttributeError) as error:
        raise MarketDataError("INVALID_NUMBER", f"{field}不是有效数字") from error
    if not number.is_finite() or number < 0 or number != number.to_integral_value():
        raise MarketDataError("INVALID_NUMBER", f"{field}必须是非负整数")
    return int(number)


def _normalize_date(value: str) -> str:
    text = value.strip().replace("/", "-")
    try:
        return datetime.strptime(text, "%Y-%m-%d").date().isoformat()
    except ValueError as error:
        raise MarketDataError("INVALID_DATE", "日期必须是有效的YYYY-MM-DD或YYYY/MM/DD") from error


def _extract_identity(metadata: str, source: Path) -> StockIdentity:
    code_match = re.search(r"(?<!\d)(\d{6})(?!\d)", metadata) or re.search(r"(\d{6})", source.stem)
    if not code_match:
        raise MarketDataError("MISSING_STOCK_CODE", "元数据和文件名中均未找到六位股票代码")
    stock_code = code_match.group(1)
    tokens = [token for token in re.split(r"[\t ]+", metadata.strip()) if token]
    stock_name = next(
        (token for token in tokens if token != stock_code and not re.fullmatch(r"\d{6}", token)
         and token not in {"日线", "后复权", "前复权", "不复权"}),
        source.stem,
    )
    market, board_type = classify_stock(stock_code)
    normalized_name = stock_name.upper().replace(" ", "")
    return StockIdentity(stock_code, stock_name, market, board_type, "ST" in normalized_name)


def _limit_rate(identity: StockIdentity) -> Decimal:
    if identity.is_st:
        return Decimal("0.05")
    if identity.board_type in {"STAR", "CHINEXT"}:
        return Decimal("0.20")
    if identity.board_type == "BSE":
        return Decimal("0.30")
    return Decimal("0.10")


def _calculated_limit(previous_close_cents: int, rate: Decimal, direction: int) -> int:
    price = Decimal(previous_close_cents) * (Decimal("1") + rate * direction)
    return int(price.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def parse_tdx_hfq_file(path: str | Path) -> dict:
    source = Path(path)
    try:
        lines = source.read_text(encoding="gbk").splitlines()
    except UnicodeDecodeError as error:
        raise MarketDataError("INVALID_ENCODING", "文件不是有效的GBK编码") from error
    if len(lines) < 3:
        raise MarketDataError("INVALID_FILE", "文件至少需要元数据、表头和一行行情")

    identity = _extract_identity(lines[0], source)
    issues: list[QualityIssue] = []
    records: list[dict] = []
    previous_date: str | None = None
    previous_close: int | None = None
    rate = _limit_rate(identity)

    for line_number, row in enumerate(csv.reader(lines[2:], delimiter="\t"), start=3):
        if not row or not any(cell.strip() for cell in row):
            continue
        if row[0].lstrip().startswith("#"):
            continue
        if len(row) < 7:
            issues.append(QualityIssue("MISSING_FIELDS", "行情行少于7列", line_number))
            continue
        try:
            trade_date = _normalize_date(row[0])
            open_cents, high_cents, low_cents, close_cents = (
                _to_cents(row[1], "开盘价"),
                _to_cents(row[2], "最高价"),
                _to_cents(row[3], "最低价"),
                _to_cents(row[4], "收盘价"),
            )
            volume = _to_non_negative_integer(row[5], "成交量")
            amount_cents = _to_cents(row[6], "成交额")
            if previous_date and trade_date <= previous_date:
                raise MarketDataError("DUPLICATE_OR_UNSORTED_DATE", "日期重复或未严格递增")
            if high_cents < max(open_cents, close_cents) or low_cents > min(open_cents, close_cents) or high_cents < low_cents:
                raise MarketDataError("INVALID_OHLC", "OHLC关系无效")
            pct_chg = None if previous_close in (None, 0) else str(
                ((Decimal(close_cents - previous_close) / Decimal(previous_close)) * 100).quantize(
                    Decimal("0.0001"), rounding=ROUND_HALF_UP
                )
            )
            records.append({
                "stockCode": identity.stock_code,
                "stockName": identity.stock_name,
                "tradeDate": trade_date,
                "openCents": open_cents,
                "highCents": high_cents,
                "lowCents": low_cents,
                "closeCents": close_cents,
                "volume": volume,
                "amountCents": amount_cents,
                "pctChg": pct_chg,
                "market": identity.market,
                "boardType": identity.board_type,
                "isSt": identity.is_st,
                "isSuspended": volume == 0,
                "limitUpPriceCents": None if previous_close is None else _calculated_limit(previous_close, rate, 1),
                "limitDownPriceCents": None if previous_close is None else _calculated_limit(previous_close, rate, -1),
                "adjustType": "hfq",
            })
            previous_date = trade_date
            previous_close = close_cents
        except MarketDataError as error:
            issues.append(QualityIssue(error.code, str(error), line_number, row[0].strip() or None))

    if issues:
        raise MarketDataError("DATA_QUALITY_FAILED", f"发现{len(issues)}条数据质量问题", issues)
    if not records:
        raise MarketDataError("NO_VALID_RECORDS", "文件没有有效行情记录")
    return {"identity": asdict(identity), "records": records, "qualityIssues": []}


def iter_source_files(source: Path) -> Iterable[Path]:
    for pattern in ("*.txt", "*.TXT", "*.csv", "*.CSV"):
        yield from source.glob(pattern)


def main() -> int:
    parser = argparse.ArgumentParser(description="校验通达信日线后复权导出文件")
    parser.add_argument("source", type=Path, help="文件或houfuquan目录")
    parser.add_argument("--limit", type=int, default=None, help="试运行最多处理文件数")
    parser.add_argument("--report", type=Path, default=None, help="质量报告JSON输出路径")
    args = parser.parse_args()

    files = [args.source] if args.source.is_file() else sorted(set(iter_source_files(args.source)))
    if args.limit is not None:
        files = files[: args.limit]
    report = {"adjustType": "hfq", "files": [], "validFiles": 0, "invalidFiles": 0, "records": 0}
    for source in files:
        try:
            result = parse_tdx_hfq_file(source)
            report["files"].append({"path": str(source), "status": "valid", "records": len(result["records"]), "identity": result["identity"]})
            report["validFiles"] += 1
            report["records"] += len(result["records"])
        except MarketDataError as error:
            report["files"].append({"path": str(source), "status": "invalid", "code": error.code, "message": str(error), "issues": [asdict(issue) for issue in error.issues]})
            report["invalidFiles"] += 1
    output = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output, encoding="utf-8")
    print(output)
    return 0 if report["invalidFiles"] == 0 and report["validFiles"] > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
