import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExternalTurnoverRepository } from "../../src/infrastructure/external-turnover-repository.mjs";

test("external turnover repository maps ratio values and caches each stock", () => {
  const directory = mkdtempSync(join(tmpdir(), "turnover-repository-"));
  const path = join(directory, "stock_daily.db");
  writeFileSync(path, "fixture");
  let calls = 0;
  const repository = createExternalTurnoverRepository(path, { execute(command, args) {
    calls += 1;
    assert.equal(command, "sqlite3");
    assert.match(args.at(-1), /SH600000/);
    return JSON.stringify([{ date: "2024-01-02", turnover_rate: 0.0523 }]);
  } });
  assert.equal(repository.load("600000", "SH").get("2024-01-02"), 52300);
  assert.equal(repository.load("600000", "SH").get("2024-01-02"), 52300);
  assert.equal(calls, 1);
  assert.throws(() => repository.load("bad", "SH"), (error) => error.code === "INVALID_STOCK_CODE");
  rmSync(directory, { recursive: true });
});
