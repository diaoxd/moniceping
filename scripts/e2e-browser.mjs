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

  await page.goto(base);
  await page.waitForURL("**/");
  await page.waitForSelector("#primaryMetrics .metric");
  await Promise.all([
    page.waitForURL("**/random.html"),
    page.getByRole("link", { name: /随机训练/ }).click(),
  ]);
  await page.getByLabel("随机种子（可选）").fill("browser-e2e-seed");
  await Promise.all([
    page.waitForURL("**/index.html"),
    page.getByRole("button", { name: "开始训练" }).click(),
  ]);
  await page.waitForSelector(".current-bar-details");
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".brand .muted")).display === "none");
  assert.equal(await page.locator(".brand .muted").isVisible(), false);
  assert.equal(await page.locator(".instrument-row .eyebrow").isVisible(), false);
  assert.equal(await page.locator(".panel-title > .top-actions").count(), 1);
  assert.equal(await page.locator(".trade-panel .eyebrow").count(), 0);
  const panelTitleCenters = await page.evaluate(() => [".panel-title h2", ".panel-title > .top-actions", ".step-label"].map((selector) => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return rect.top + rect.height / 2;
  }));
  assert.ok(Math.max(...panelTitleCenters) - Math.min(...panelTitleCenters) < 8);
  const compactLayout = await page.evaluate(() => {
    const center = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    const volume = document.getElementById("volumeChart").getBoundingClientRect();
    return {
      centers: [center(".instrument-row h1"), center(".ohlc"), center(".chart-actions")],
      volumeBottom: volume.bottom,
      volumeHeight: volume.height,
      viewportHeight: innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    };
  });
  assert.ok(Math.max(...compactLayout.centers) - Math.min(...compactLayout.centers) < 12);
  assert.ok(compactLayout.volumeHeight > 100);
  assert.ok(compactLayout.volumeBottom <= compactLayout.viewportHeight);
  assert.ok(compactLayout.documentHeight <= compactLayout.viewportHeight);
  assert.match(await page.locator(".instrument-row h1").innerText(), /浏览器测试股/);
  const expectedDailyChange = await page.evaluate(() => {
    const bars = JSON.parse(sessionStorage.randomTrainingState).bars.daily;
    return `${bars.at(-1).closeCents > bars.at(-2).closeCents ? "+" : ""}${((bars.at(-1).closeCents - bars.at(-2).closeCents) / bars.at(-2).closeCents * 100).toFixed(2)}%`;
  });
  assert.equal(await page.locator(".price-change").innerText(), expectedDailyChange);
  assert.equal(await page.locator("#stepNumber").innerText(), "0");
  assert.equal(await page.locator("#dateLabel").innerText(), "日期已隐藏");
  assert.match(await page.locator(".current-bar-details").innerText(), /开.*高.*低.*收/s);

  const initialLayout = await page.evaluate(() => window.trainingChartLayout);
  assert.equal(initialLayout.visibleCount, 100);
  assert.ok(initialLayout.blankSlots > 0);
  assert.ok(initialLayout.trainingStartX !== null);
  assert.equal(initialLayout.trainingStartX, initialLayout.latestX);
  const selectedBarResult = await page.evaluate(() => {
    const layout = window.trainingChartLayout;
    const visibleIndex = layout.shownCount - 5;
    const absoluteIndex = layout.offset + visibleIndex;
    const canvas = document.getElementById("priceChart");
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + layout.firstX + visibleIndex * layout.step, clientY: rect.top + rect.height / 2 }));
    const state = JSON.parse(sessionStorage.randomTrainingState);
    return { selected: state.bars.daily[absoluteIndex], latest: state.bars.daily.at(-1), absoluteIndex };
  });
  await page.waitForFunction(() => document.querySelector(".current-bar-details")?.textContent?.includes("选中 K 线"));
  const selectedStopLine = await page.evaluate(() => window.trainingChartLayout.selectedStopLine);
  assert.equal(selectedStopLine.priceCents, selectedBarResult.selected.lowCents);
  assert.ok(selectedStopLine.startX < selectedStopLine.endX);
  assert.equal(selectedStopLine.endX, (await page.evaluate(() => window.trainingChartLayout.latestX)));
  assert.equal(selectedStopLine.label, `最低 ${(selectedBarResult.selected.lowCents / 100).toFixed(2)}`);
  assert.ok(selectedStopLine.labelY > selectedStopLine.y);
  assert.equal(await page.locator("#openVal").innerText(), (selectedBarResult.selected.openCents / 100).toFixed(2));
  assert.equal(await page.locator("#highVal").innerText(), (selectedBarResult.selected.highCents / 100).toFixed(2));
  assert.equal(await page.locator("#lowVal").innerText(), (selectedBarResult.selected.lowCents / 100).toFixed(2));
  assert.equal(await page.locator("#closeVal").innerText(), (selectedBarResult.selected.closeCents / 100).toFixed(2));
  assert.match(await page.locator(".current-bar-details").innerText(), new RegExp(`编号 ${selectedBarResult.selected.index}`));
  assert.equal(Number(await page.locator("#priceInput").inputValue()), selectedBarResult.latest.closeCents / 100);
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
  assert.match(await page.locator(".current-bar-details").innerText(), /当前 K 线/);
  assert.equal((await page.evaluate(() => window.trainingChartLayout.selectedStopLine)), null);
  assert.equal(await page.locator("#stepNumber").innerText(), "1");
  const advancedLayout = await page.evaluate(() => window.trainingChartLayout);
  assert.ok(advancedLayout.trainingStartX < advancedLayout.latestX);
  assert.match(await page.locator(".current-bar-details").innerText(), /编号 1/);

  await page.getByRole("button", { name: "周线" }).click();
  assert.match(await page.locator(".ma-live-value").first().innerText(), /^MA/);
  const expectedWeeklyChange = await page.evaluate(() => {
    const bars = JSON.parse(sessionStorage.randomTrainingState).bars.weekly;
    return `${bars.at(-1).closeCents > bars.at(-2).closeCents ? "+" : ""}${((bars.at(-1).closeCents - bars.at(-2).closeCents) / bars.at(-2).closeCents * 100).toFixed(2)}%`;
  });
  assert.equal(await page.locator(".price-change").innerText(), expectedWeeklyChange);
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

  await page.getByRole("button", { name: "买入", exact: true }).first().click();
  const maximumBuyQuantity = await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState).maximumBuyQuantity);
  assert.equal(Number(await page.locator("#quantityInput").inputValue()), maximumBuyQuantity);
  await page.getByRole("button", { name: "1/3", exact: true }).click();
  assert.equal(Number(await page.locator("#quantityInput").inputValue()), Math.floor(maximumBuyQuantity / 3 / 100) * 100);
  await page.locator("#buyBtn").click();
  await page.waitForFunction(() => document.getElementById("tradeCount")?.textContent === "共 1 笔");
  assert.match(await page.locator("#holding").innerText(), /股 \/ 可卖 0 股/);
  assert.equal(await page.locator("#undoBtn").isDisabled(), true);

  await page.locator("#observeBtn").click();
  await page.waitForSelector("#stopLossRequiredDialog:not([hidden])");
  assert.match(await page.locator("#stopLossRequiredDialog").innerText(), /请先下止损条件单/);
  assert.equal(await page.locator("#stepNumber").innerText(), "1");
  pageErrors.length = 0;
  await page.getByRole("button", { name: "去下条件单", exact: true }).click();
  await page.waitForSelector("#conditionalOrderForm:not([hidden])");
  assert.equal(await page.locator("#marketOrderForm").isHidden(), true);
  await page.getByRole("button", { name: "条件卖出", exact: true }).click();
  await page.getByRole("button", { name: "股价下穿", exact: true }).click();
  await page.locator("#conditionPrice").fill("0.01");
  const heldQuantity = await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState).position.quantity);
  await page.locator("#conditionQuantity").fill(String(heldQuantity));
  await page.getByRole("button", { name: "创建条件单", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("conditionalStatus")?.textContent?.includes("创建成功"));
  await page.getByRole("button", { name: "当前挂单", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".trade-tab-view")?.textContent?.includes("下穿"));
  assert.match(await page.locator(".trade-tab-view").innerText(), /卖出 · 下穿/);

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
  await page.getByRole("button", { name: "市价单", exact: true }).click();
  await page.getByRole("button", { name: "卖出", exact: true }).first().click();
  const availableQuantity = await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState).position.availableQuantity);
  assert.equal(Number(await page.locator("#quantityInput").inputValue()), availableQuantity);
  await page.getByRole("button", { name: "1/2", exact: true }).click();
  assert.equal(Number(await page.locator("#quantityInput").inputValue()), Math.floor(availableQuantity / 2 / 100) * 100);
  await page.locator("#quantityInput").fill("100");
  await page.locator("#sellBtn").click();
  await page.waitForFunction(() => document.getElementById("tradeCount")?.textContent === "共 2 笔");
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState).fills.at(-1).quantity), 100);
  const dailyTradeMarkers = await page.evaluate(() => window.trainingTradeMarkers);
  assert.equal(dailyTradeMarkers.length, 2);
  assert.deepEqual(dailyTradeMarkers.map((marker) => marker.side).sort(), ["buy", "sell"]);
  assert.ok(dailyTradeMarkers.every((marker) => Number.isFinite(marker.x) && Number.isFinite(marker.y)));
  await page.getByRole("button", { name: "周线" }).click();
  assert.equal((await page.evaluate(() => window.trainingTradeMarkers)).length, 2);
  await page.getByRole("button", { name: "月线" }).click();
  assert.equal((await page.evaluate(() => window.trainingTradeMarkers)).length, 2);
  await page.getByRole("button", { name: "日线" }).click();

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
  await page.locator("#stepSlider").evaluate((slider) => {
    slider.value = slider.max;
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const slider = document.getElementById("stepSlider");
    return document.getElementById("stepLabel")?.textContent?.startsWith(`第 ${slider.max} /`);
  });
  const reviewMarkers = await page.evaluate(() => window.reviewTradeMarkers);
  assert.equal(reviewMarkers.length, 2);
  assert.deepEqual(reviewMarkers.map((marker) => marker.side).sort(), ["buy", "sell"]);
  assert.ok(reviewMarkers.every((marker) => marker.quantity > 0));
  assert.match(await page.locator("#tradeSummaryBody").innerText(), /买入/);
  assert.match(await page.locator("#tradeSummaryBody").innerText(), /卖出/);
  assert.ok(completedSessionId);

  await page.goto(`${base}/random.html`);
  await page.getByLabel("随机种子（可选）").fill("manual-finish-seed");
  await Promise.all([
    page.waitForURL("**/index.html"),
    page.getByRole("button", { name: "开始训练" }).click(),
  ]);
  await page.locator("#buyBtn").click();
  await page.waitForFunction(() => document.getElementById("tradeCount")?.textContent === "共 1 笔");
  await page.getByRole("button", { name: "结束本局", exact: true }).click();
  await page.waitForSelector("#finishDialog:not([hidden])");
  assert.match(await page.locator("#finishDialog").innerText(), /要结束这局训练吗？/);
  assert.equal(await page.locator("#finishRemaining").innerText(), "150");
  await page.getByRole("button", { name: "继续训练" }).click();
  assert.equal(await page.locator("#finishDialog").isHidden(), true);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState).status), "running");

  await page.getByRole("button", { name: "结束本局测评" }).click();
  const finalEquityCents = await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState).account.equityCents);
  const previousStockCode = await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState).stockCode);
  await page.getByRole("button", { name: "下一局" }).click();
  assert.equal(await page.getByRole("button", { name: "下一局" }).isDisabled(), true);
  await page.waitForFunction((stockCode) => {
    const next = JSON.parse(sessionStorage.getItem("randomTrainingState") || "null");
    return next?.status === "running" && next.stockCode !== stockCode;
  }, previousStockCode);
  const nextState = await page.evaluate(() => JSON.parse(sessionStorage.randomTrainingState));
  const nextRoundDashboard = await page.evaluate(() => fetch("/api/training-dashboard").then((response) => response.json()));
  assert.notEqual(nextState.stockCode, previousStockCode);
  assert.equal(nextState.simulationBars, 150);
  assert.equal(nextState.initialCapitalCents, nextRoundDashboard.currentEquityCents);
  assert.equal(nextState.account.equityCents, nextRoundDashboard.currentEquityCents);

  await page.getByRole("button", { name: "结束本局测评" }).click();
  await Promise.all([
    page.waitForURL("**/dashboard.html"),
    page.getByRole("button", { name: "确认退出" }).click(),
  ]);
  await page.waitForSelector("#primaryMetrics .metric");
  assert.match(await page.locator(".summary-band").innerText(), /当前资产/);
  assert.match(await page.locator(".summary-band").innerText(), /累计盈亏/);
  await page.getByRole("link", { name: "历史训练", exact: true }).click();
  await page.waitForURL("**/history.html");
  await Promise.all([
    page.waitForURL("**/dashboard.html"),
    page.getByRole("link", { name: "返回训练总览" }).click(),
  ]);
  const dashboardSummary = await page.evaluate(() => fetch("/api/training-dashboard").then((response) => response.json()));
  assert.equal(Number((await page.locator("#currentEquity").innerText()).replaceAll(",", "")), dashboardSummary.currentEquityCents / 100);
  assert.equal(dashboardSummary.currentEquityCents, dashboardSummary.startingCapitalCents + dashboardSummary.totalProfitCents);
  assert.match(await page.locator("#secondaryMetrics").innerText(), /累计交易时间/);
  const curveHasPixels = await page.locator("#equityCurve").evaluate((canvas) => [...canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data].some((value) => value !== 0));
  assert.equal(curveHasPixels, true);
  const savedCapitalCents = await page.evaluate(() => Number(localStorage.getItem("randomTrainingCapitalCents")));
  assert.equal(savedCapitalCents, dashboardSummary.currentEquityCents);
  await page.goto(`${base}/random.html`);
  assert.equal(Number(await page.getByLabel("初始资金（元）").inputValue()), savedCapitalCents / 100);
  await page.goto(`${base}/dashboard.html`);
  await page.waitForSelector("#primaryMetrics .metric");
  await Promise.all([
    page.waitForURL("**/random.html"),
    page.getByRole("button", { name: "重置训练资金" }).click(),
  ]);
  assert.equal(Number(await page.getByLabel("初始资金（元）").inputValue()), 1_000_000);

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
