import tempfile
import unittest
from pathlib import Path

from tools.market_data.market_db import connect_market_database, import_hfq_file


FIXTURE = """000001 平安银行 日线 后复权
日期\t开盘\t最高\t最低\t收盘\t成交量\t成交额
2020/12/30\t10.00\t10.50\t9.80\t10.20\t1000\t10000.50
2020/12/31\t10.20\t11.30\t10.10\t11.22\t0\t0
#数据来源:通达信
"""


class MarketDatabaseTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.source = root / "SZ#000001.txt"
        self.source.write_bytes(FIXTURE.encode("gbk"))
        self.database = connect_market_database(root / "market.db")
        self.addCleanup(self.database.close)

    def test_migration_creates_market_schema(self):
        tables = {row[0] for row in self.database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"schema_migrations", "stocks", "daily_bars"}.issubset(tables))
        version = self.database.execute("SELECT version FROM schema_migrations").fetchone()[0]
        self.assertEqual(version, "001_initial.sql")

    def test_import_persists_stock_and_integer_price_bars(self):
        result = import_hfq_file(self.database, self.source)
        self.assertEqual(result["records"], 2)
        stock = self.database.execute("SELECT * FROM stocks WHERE stock_code='000001'").fetchone()
        self.assertEqual(stock["adjust_type"], "hfq")
        self.assertEqual(stock["bar_count"], 2)
        bar = self.database.execute(
            "SELECT * FROM daily_bars WHERE stock_code='000001' ORDER BY trade_date LIMIT 1"
        ).fetchone()
        self.assertEqual(bar["close_cents"], 1020)
        self.assertEqual(bar["amount_cents"], 1_000_050)

    def test_reimport_replaces_series_without_duplicates(self):
        import_hfq_file(self.database, self.source)
        import_hfq_file(self.database, self.source)
        count = self.database.execute("SELECT count(*) FROM daily_bars WHERE stock_code='000001'").fetchone()[0]
        self.assertEqual(count, 2)


if __name__ == "__main__":
    unittest.main()
