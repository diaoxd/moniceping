import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from tools.market_data.audit_market_db import audit_market_database
from tools.market_data.market_db import connect_market_database


class MarketDatabaseAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "market.db"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def populate(self, count=600):
        database = connect_market_database(self.database_path)
        database.execute("""
            INSERT INTO stocks(stock_code, stock_name, market, board_type, is_st, adjust_type,
              first_trade_date, last_trade_date, bar_count, source_file, source_mtime_ns)
            VALUES ('600000', '测试股票', 'SH', 'MAIN', 0, 'hfq', ?, ?, ?, 'fixture', 1)
        """, ("2020-01-01", (date(2020, 1, 1) + timedelta(days=count - 1)).isoformat(), count))
        start = date(2020, 1, 1)
        database.executemany("""
            INSERT INTO daily_bars(stock_code, trade_date, open_cents, high_cents, low_cents,
              close_cents, volume, amount_cents, pct_chg, is_suspended,
              limit_up_price_cents, limit_down_price_cents)
            VALUES ('600000', ?, 1000, 1010, 990, 1000, 100, 100000, NULL, 0, NULL, NULL)
        """, [((start + timedelta(days=index)).isoformat(),) for index in range(count)])
        database.commit()
        database.close()

    def test_valid_database_passes_with_candidate_counts(self):
        self.populate()
        report = audit_market_database(self.database_path)
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["summary"]["stockCount"], 1)
        self.assertEqual(report["summary"]["barCount"], 600)
        self.assertEqual(report["eligible"]["simulation150"], 1)

    def test_empty_and_inconsistent_databases_fail(self):
        database = connect_market_database(self.database_path)
        database.close()
        self.assertEqual(audit_market_database(self.database_path)["status"], "FAIL")
        self.populate()
        database = sqlite3.connect(self.database_path)
        database.execute("UPDATE stocks SET bar_count = bar_count + 1")
        database.commit()
        database.close()
        report = audit_market_database(self.database_path)
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["quality"]["barCountMismatches"], 1)


if __name__ == "__main__":
    unittest.main()
