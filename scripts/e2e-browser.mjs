import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "trainer-browser-e2e-"));
const marketPath = join(temporaryDirectory, "market.db");
const appPath = join(temporaryDirectory, "app.db");
const port = Number(process.env.BROWSER_E2E_PORT || 4198);
const base = `http://127.0.0.1:${port}`;

function createMarketFixture() {
  const database = new DatabaseSync(marketPath);
  database.exec(readFileSync(join(root, "migrations/market/001_initial.sql"), "utf8"));
  const insertStock = database.prepare(`INSERT INTO stocks(stock_code, stock_name, market, board_type, is_st,
    adjust_type, first_trade_date, last_trade_date, bar_count, source_file, source_mtime_ns)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertStock.run("600000", "浏览器测试股A", "SH", "MAIN", 0, "hfq", "2020-01-01", "2023-12-31", 800, "fixture-a", 1);
  insertStock.run("000001", "浏览器测试股B", "SZ", "MAIN", 0, "hfq", "2020-01-01", "2023-12-31", 800, "fixture-b", 1);
  const insert = database.prepare(`INSERT INTO daily_bars(stock_code, trade_date, open_cents,
    high_cents, low_cents, close_cents, volume, amount_cents, pct_chg, is_suspended,
    limit_up_price_cents, limit_down_price_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [stockCode, offset] of [["600000", 0], ["000001", 200]]) {
    for (let index = 0; index < 800; index += 1) {
      const tradeDate = new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10);
      const close = 1000 + offset + index + Math.round(Math.sin(index / 13) * 80);
      insert.run(stockCode, tradeDate, close - 5, close + 15, close - 20, close,
        100_000 + index * 100, 100_000_000 + index * 1000, null, 0, null, null);
    }
  }
  database.close();
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("浏览器测试服务启动超时");
}

createMarketFixture();
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), APP_DATABASE: appPath, MARKET_DATABASE: marketPath },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });

  await page.goto(`${base}/random.html`);
  await page.getByLabel("随机种子（可选）").fill("browser-e2e-seed");
  await Promise.all([
    page.waitForURL("**/index.html"),
    page.getByRole("button", { name: "开始训练" }).click(),
  ]);
  await page.waitForSelector(".current-bar-details");
  assert.match(await page.locator(".instrument-row h1").innerText(), /浏览器测试股/);
  assert.equal(await page.locator("#stepNumber").innerText(), "0");
  assert.equal(await page.locator("#dateLabel").innerText(), "日期已隐藏");
  assert.match(await page.locator(".current-bar-details").innerText(), /开.*高.*低.*收/s);

  const initialLayout = await page.evaluate(() => window.trainingChartLayout);
  assert.equal(initialLayout.visibleCount, 100);
  assert.ok(initialLayout.blankSlots > 0);
  assert.ok(initialLayout.trainingStartX !== null);
  assert.equal(initialLayout.trainingStartX, initialLayout.latestX);
  await page.waitForFunction(() => {
    const line = document.querySelector(".current-price-line");
    const label = line?.querySelector("span");
    return line && label && line.getBoundingClientRect().left >= document.getElementById("priceChart").getBoundingClientRect().left + window.trainingChartLayout.latestX - 1
      && label.getBoundingClientRect().left > line.getBoundingClientRect().left;
  });
  await page.keyboard.press("ArrowUp");
  assert.equal((await page.evaluate(() => window.trainingChartLayout)).visibleCount, 90);
  await page.locator("#priceChart").hover();
  await page.mouse.wheel(0, -100);
  assert.equal((await page.evaluate(() => window.trainingChartLayout)).visibleCount, 80);
  await page.getByRole("button", { name: "重置图表视图" }).click();
  assert.equal((await page.evaluate(() => window.trainingChartLayout)).visibleCount, 100);

  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.getElementById("stepNumber")?.textContent === "1");
  assert.equal(await page.locator("#stepNumber").innerText(), "1");
  const advancedLayout = await page.evaluate(() => window.trainingChartLayout);
  assert.ok(advancedLayout.trainingStartX < advancedLayout.latestX);
  assert.match(await page.locator(".current-bar-details").innerText(), /编号 1/);

  await page.getByRole("button", { name: "周线" }).click();
  assert.match(await page.locator(".ma-live-value").first().innerText(), /^MA/);
  const weeklyLayout = await page.evaluate(() => window.trainingChartLayout);
  assert.ok(weeklyLayout.visibleCount <= 40 && weeklyLayout.visibleCount > 10);
  await page.keyboard.press("ArrowUp");
  assert.equal((await page.evaluate(() => window.trainingChartLayout)).visibleCount, Math.max(10, weeklyLayout.visibleCount - 5));
  await page.getByRole("button", { name: "月线" }).click();
  const monthlyLayout = await page.evaluate(() => window.trainingChartLayout);
  assert.ok(monthlyLayout.visibleCount <= 18 && monthlyLayout.visibleCount >= 6);
  await page.keyboard.press("ArrowUp");
  assert.equal((await page.evaluate(() => window.trainingChartLayout)).visibleCount, Math.max(6, monthlyLayout.visibleCount - 3));
  await page.getByRole("button", { name: "日线" }).click();
  assert.equal((await page.evaluate(() => window.trainingChartLayout)).visibleCount, 100);

  await page.locator("#buyBtn").click();
  await page.waitForFunction(() => document.getElementById("tradeCount")?.textContent === "共 1 笔");
  assert.match(await page.locator("#holding").innerText(), /股 \/ 可卖 0 股/);
  assert.equal(await page.locator("#undoBtn").isDisabled(), true);

  await page.getByRole("button", { name: "明细", exact: true }).click();
  assert.match(await page.locator(".trade-tab-view").innerText(), /买入/);
  await page.getByRole("button", { name: "资金曲线", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("curveStatus")?.textContent?.startsWith("共 "));
  assert.equal(await page.locator("#panelEquityCurve").isVisible(), true);
  const curvePixels = await page.locator("#panelEquityCurve").evaluate((canvas) => {
    const context = canvas.getContext("2d");
    return [...context.getImageData(0, 0, canvas.width, canvas.height).data].some((value) => value !== 0);
  });
  assert.equal(curvePixels, true);

  await page.locator("#observeBtn").click();
  await page.waitForFunction(() => document.getElementById("stepNumber")?.textContent === "2");
  assert.match(await page.locator("#holding").innerText(), /可卖 [1-9][0-9,]* 股/);
  await page.locator("#sellBtn").click();
  await page.waitForFunction(() => document.getElementById("tradeCount")?.textContent === "共 2 笔");

  const completedSessionId = await page.evaluate(async () => {
    let state = JSON.parse(sessionStorage.getItem("randomTrainingState"));
    while (state.status === "running") {
      const response = await fetch(`/api/random-training-sessions/${encodeURIComponent(state.id)}/advance`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: state.version }),
      });
      state = await response.json();
      if (!response.ok) throw new Error(state.error?.message || "推进失败");
    }
    sessionStorage.setItem("randomTrainingState", JSON.stringify(state));
    return state.id;
  });
  await page.goto(`${base}/history.html`);
  await page.waitForSelector("[data-report]");
  assert.match(await page.locator("#list").innerText(), /已完成/);

  await Promise.all([
    page.waitForURL("**/report.html?id=**"),
    page.getByRole("button", { name: "结算报告" }).click(),
  ]);
  await page.waitForSelector("#metrics .metric");
  assert.match(await page.locator("#title").innerText(), /浏览器测试股/);
  await page.waitForFunction(() => document.getElementById("equityCurve") instanceof HTMLCanvasElement);
  assert.equal(await page.locator("#equityCurve").isVisible(), true);

  await page.goto(`${base}/history.html`);
  await page.waitForSelector("[data-review]");
  await Promise.all([
    page.waitForURL("**/review.html?id=**"),
    page.getByRole("button", { name: "进入复盘" }).click(),
  ]);
  await page.waitForSelector("#reviewChart");
  assert.match(await page.locator("#instrument").innerText(), /浏览器测试股/);
  assert.match(page.url(), new RegExp(`review\\.html\\?id=.+&step=0`));
  assert.ok(completedSessionId);

  await page.goto(`${base}/random.html`);
  await page.getByLabel("随机种子（可选）").fill("manual-finish-seed");
  await Promise.all([
    page.waitForURL("**/index.html"),
    page.getByRole("button", { name: "开始训练" }).click(),
  ]);
  await page.locator("#buyBtn").click();
  await page.waitForFunction(() => document.getElementById("tradeCount")?.textContent === "共 1 笔");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "结束本局" }).click();
  await page.waitForFunction(() => document.getElementById("finishBtn")?.textContent === "下一局");
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState).status), "finished");
  const finalEquityCents = await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState).account.equityCents);
  const previousStockCode = await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState).stockCode);
  await page.getByRole("button", { name: "下一局" }).click();
  await page.waitForFunction((stockCode) => {
    const next = JSON.parse(sessionStorage.getItem("randomTrainingState") || "null");
    return next?.status === "running" && next.stockCode !== stockCode;
  }, previousStockCode);
  const nextState = await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState));
  assert.notEqual(nextState.stockCode, previousStockCode);
  assert.equal(nextState.simulationBars, 150);
  assert.equal(nextState.initialCapitalCents, finalEquityCents);
  assert.equal(nextState.account.equityCents, finalEquityCents);

  assert.deepEqual(pageErrors, []);
  console.log("Browser E2E click flow passed");
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  rmSync(temporaryDirectory, { recursive: true });
}
