import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "trainer-e2e-"));
const marketPath = join(temporaryDirectory, "market.db");
const appPath = join(temporaryDirectory, "app.db");
const port = Number(process.env.E2E_PORT || 4197);
const base = `http://127.0.0.1:${port}`;

function createMarketFixture() {
  const database = new DatabaseSync(marketPath);
  database.exec(readFileSync(join(root, "migrations/market/001_initial.sql"), "utf8"));
  database.prepare(`INSERT INTO stocks(stock_code, stock_name, market, board_type, is_st,
    adjust_type, first_trade_date, last_trade_date, bar_count, source_file, source_mtime_ns)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("600000", "端到端测试股", "SH", "MAIN", 0, "hfq", "2020-01-01", "2023-12-31", 800, "fixture", 1);
  const insert = database.prepare(`INSERT INTO daily_bars(stock_code, trade_date, open_cents,
    high_cents, low_cents, close_cents, volume, amount_cents, pct_chg, is_suspended,
    limit_up_price_cents, limit_down_price_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let index = 0; index < 800; index += 1) {
    const tradeDate = new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10);
    const close = 1000 + index + Math.round(Math.sin(index / 13) * 80);
    insert.run("600000", tradeDate, close - 5, close + 15, close - 20, close,
      100_000 + index * 100, 100_000_000 + index * 1000, null, 0, null, null);
  }
  database.close();
}

async function json(path, options) {
  const response = await fetch(`${base}${path}`, options);
  const payload = await response.json();
  return { response, payload };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("服务启动超时");
}

function startServer() {
  return spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), APP_DATABASE: appPath, MARKET_DATABASE: marketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await once(server, "exit");
}

createMarketFixture();
let child = startServer();

try {
  await waitForServer();
  const health = await json("/api/health");
  assert.equal(health.payload.marketDatabase, true);

  let result = await json("/api/random-training-sessions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ simulationBars: 150, seed: "e2e-seed", initialCapitalCents: 100_000_000 }),
  });
  assert.equal(result.response.status, 201);
  let state = result.payload;
  assert.equal(state.bars.daily.length, 200);
  assert.equal(state.datesRevealed, false);
  assert.equal(state.bars.daily.some((bar) => "tradeDate" in bar), false);

  result = await json(`/api/random-training-sessions/${state.id}/trade`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: state.version, side: "buy", quantity: 100 }),
  });
  state = result.payload;
  assert.equal(state.position.quantity, 100);
  assert.equal(state.position.availableQuantity, 0);

  const blockedRollback = await json(`/api/random-training-sessions/${state.id}/rollback`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: state.version }),
  });
  assert.equal(blockedRollback.response.status, 422);

  state = (await json(`/api/random-training-sessions/${state.id}/advance`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: state.version }),
  })).payload;
  assert.equal(state.position.availableQuantity, 100);

  const beforeRestart = {
    id: state.id, version: state.version, cashCents: state.account.cashCents,
    equityCents: state.account.equityCents, positionQuantity: state.position.quantity,
    availableQuantity: state.position.availableQuantity, advancesCompleted: state.advancesCompleted,
    orderCount: state.orders.length, fillCount: state.fills.length,
  };
  await stopServer(child);
  child = startServer();
  await waitForServer();
  const recovered = await json(`/api/random-training-sessions/${state.id}`);
  assert.equal(recovered.response.status, 200);
  state = recovered.payload;
  assert.deepEqual({
    id: state.id, version: state.version, cashCents: state.account.cashCents,
    equityCents: state.account.equityCents, positionQuantity: state.position.quantity,
    availableQuantity: state.position.availableQuantity, advancesCompleted: state.advancesCompleted,
    orderCount: state.orders.length, fillCount: state.fills.length,
  }, beforeRestart);

  const staleAdvance = await json(`/api/random-training-sessions/${state.id}/advance`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: state.version - 1 }),
  });
  assert.equal(staleAdvance.response.status, 409);
  assert.equal(staleAdvance.payload.error.code, "VERSION_CONFLICT");

  state = (await json(`/api/random-training-sessions/${state.id}/trade`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: state.version, side: "sell", quantity: 100 }),
  })).payload;
  assert.equal(state.position.quantity, 0);

  const advanceDurations = [];
  while (state.status === "running") {
    const startedAt = performance.now();
    state = (await json(`/api/random-training-sessions/${state.id}/advance`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: state.version }),
    })).payload;
    advanceDurations.push(performance.now() - startedAt);
  }
  assert.equal(state.advancesCompleted, 150);
  assert.equal(state.datesRevealed, true);
  const totalAdvanceDuration = advanceDurations.reduce((sum, duration) => sum + duration, 0);
  const maximumAdvanceDuration = Math.max(...advanceDurations);
  assert.ok(totalAdvanceDuration < 30_000, `推进总耗时过长：${totalAdvanceDuration.toFixed(1)}ms`);
  assert.ok(maximumAdvanceDuration < 2_000, `单次推进耗时过长：${maximumAdvanceDuration.toFixed(1)}ms`);

  const report = await json(`/api/random-training-sessions/${state.id}/report`);
  assert.equal(report.response.status, 200);
  assert.equal(report.payload.equityCurve.length, state.advancesCompleted + 1);
  const review = await json(`/api/random-training-sessions/${state.id}/reviews`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(review.response.status, 201);
  const reviewStep = await json(`/api/reviews/${review.payload.id}/steps/${review.payload.startStep}`);
  assert.equal(reviewStep.response.status, 200);

  const history = await json("/api/random-training-sessions?status=finished&limit=5&offset=0");
  assert.equal(history.payload.total, 1);
  assert.equal(history.payload.items[0].fillCount, 2);
  assert.equal((await fetch(`${base}/history.html`)).status, 200);
  assert.equal((await fetch(`${base}/trade-panel-tabs.js`)).status, 200);
  assert.equal((await fetch(`${base}/current-bar-details.js`)).status, 200);
  console.log(`E2E full training flow passed; advance avg ${(totalAdvanceDuration / advanceDurations.length).toFixed(1)}ms, max ${maximumAdvanceDuration.toFixed(1)}ms`);
} finally {
  await stopServer(child);
  rmSync(temporaryDirectory, { recursive: true });
}
