import tempfile
import unittest
from pathlib import Path

from tools.market_data.tdx_hfq import MarketDataError, classify_stock, parse_tdx_hfq_file


VALID_TEXT = """000001 平安银行 日线 后复权
日期\t开盘\t最高\t最低\t收盘\t成交量\t成交额
2020/12/30\t10.00\t10.50\t9.80\t10.20\t1000\t10000.50
2020/12/31\t10.20\t11.30\t10.10\t11.22\t0\t0
#数据来源:通达信
"""


class TdxHfqParserTest(unittest.TestCase):
    def write_fixture(self, text: str) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "SZ#000001.txt"
        path.write_bytes(text.encode("gbk"))
        return path

    def test_market_classification_matches_confirmed_rules(self):
        self.assertEqual(classify_stock("600000"), ("SH", "MAIN"))
        self.assertEqual(classify_stock("688001"), ("SH", "STAR"))
        self.assertEqual(classify_stock("300001"), ("SZ", "CHINEXT"))
        self.assertEqual(classify_stock("000001"), ("SZ", "MAIN"))
        self.assertEqual(classify_stock("920001"), ("BJ", "BSE"))
        self.assertEqual(classify_stock("900001"), ("UNKNOWN", "UNKNOWN"))

    def test_gbk_tab_file_is_parsed_as_hfq_integer_money(self):
        result = parse_tdx_hfq_file(self.write_fixture(VALID_TEXT))
        self.assertEqual(result["identity"]["stock_code"], "000001")
        self.assertEqual(result["identity"]["market"], "SZ")
        self.assertEqual(len(result["records"]), 2)
        self.assertEqual(result["records"][0]["closeCents"], 1020)
        self.assertEqual(result["records"][0]["amountCents"], 1_000_050)
        self.assertEqual(result["records"][1]["pctChg"], "10.0000")
        self.assertTrue(result["records"][1]["isSuspended"])
        self.assertEqual(result["records"][1]["limitUpPriceCents"], 1122)
        self.assertEqual(result["records"][1]["adjustType"], "hfq")

    def test_invalid_ohlc_is_reported_with_source_line(self):
        text = VALID_TEXT.replace("10.50\t9.80", "9.00\t9.80")
        with self.assertRaises(MarketDataError) as context:
            parse_tdx_hfq_file(self.write_fixture(text))
        self.assertEqual(context.exception.code, "DATA_QUALITY_FAILED")
        self.assertEqual(context.exception.issues[0].code, "INVALID_OHLC")
        self.assertEqual(context.exception.issues[0].line_number, 3)

    def test_identical_duplicate_rows_are_skipped(self):
        duplicate = "2020/12/30\t10.00\t10.50\t9.80\t10.20\t1000\t10000.50\n"
        text = VALID_TEXT.replace("2020/12/31", duplicate + "2020/12/31")
        result = parse_tdx_hfq_file(self.write_fixture(text))
        self.assertEqual(len(result["records"]), 2)
        self.assertEqual(result["duplicateRowsSkipped"], 1)

    def test_identical_repeated_historical_block_is_skipped(self):
        repeated = "2020/12/30\t10.00\t10.50\t9.80\t10.20\t1000\t10000.50\n"
        text = VALID_TEXT.replace("#数据来源:通达信", repeated + "#数据来源:通达信")
        result = parse_tdx_hfq_file(self.write_fixture(text))
        self.assertEqual([row["tradeDate"] for row in result["records"]], ["2020-12-30", "2020-12-31"])
        self.assertEqual(result["duplicateRowsSkipped"], 1)

    def test_conflicting_duplicate_dates_are_rejected(self):
        text = VALID_TEXT.replace("2020/12/31\t10.20", "2020/12/30\t10.21")
        with self.assertRaises(MarketDataError) as context:
            parse_tdx_hfq_file(self.write_fixture(text))
        self.assertEqual(context.exception.issues[0].code, "DUPLICATE_DATE_CONFLICT")

    def test_unseen_unsorted_date_is_rejected(self):
        extra = "2020/12/29\t10.00\t10.50\t9.80\t10.20\t1000\t10000.50\n"
        text = VALID_TEXT.replace("#数据来源:通达信", extra + "#数据来源:通达信")
        with self.assertRaises(MarketDataError) as context:
            parse_tdx_hfq_file(self.write_fixture(text))
        self.assertEqual(context.exception.issues[0].code, "UNSORTED_DATE")

    def test_non_comment_short_line_is_still_rejected(self):
        text = VALID_TEXT.replace("#数据来源:通达信", "损坏的行情行")
        with self.assertRaises(MarketDataError) as context:
            parse_tdx_hfq_file(self.write_fixture(text))
        self.assertEqual(context.exception.issues[0].code, "MISSING_FIELDS")
        self.assertEqual(context.exception.issues[0].line_number, 5)


if __name__ == "__main__":
    unittest.main()
