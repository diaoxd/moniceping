import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function createExternalTurnoverRepository(databasePath, { execute = execFileSync } = {}) {
  if (!databasePath || !existsSync(databasePath)) {
    throw Object.assign(new Error("换手率数据库不存在"), { code: "TURNOVER_DATABASE_UNAVAILABLE" });
  }
  const cache = new Map();
  return Object.freeze({
    load(stockCode, market) {
      if (!/^\d{6}$/.test(stockCode) || !["SH", "SZ", "BJ"].includes(market)) {
        throw Object.assign(new Error("换手率查询股票代码无效"), { code: "INVALID_STOCK_CODE" });
      }
      const sourceCode = `${market}${stockCode}`;
      if (cache.has(sourceCode)) return cache.get(sourceCode);
      const uri = `file:${databasePath}?immutable=1`;
      const query = `SELECT date, turnover_rate FROM qfq_hybrid_wm WHERE code='${sourceCode}' AND turnover_rate IS NOT NULL ORDER BY date`;
      const output = execute("sqlite3", ["-readonly", "-json", uri, query], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      const rows = JSON.parse(output || "[]");
      const rates = new Map(rows.map((row) => [row.date, Math.round(row.turnover_rate * 1_000_000)]));
      cache.set(sourceCode, rates);
      return rates;
    },
    clear() { cache.clear(); },
  });
}
