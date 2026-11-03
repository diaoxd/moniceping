let state = JSON.parse(sessionStorage.getItem("randomTrainingState") || "null");
let period = "daily";
let indicatorMode = "volume";

const pc = document.getElementById("priceChart");
const vc = document.getElementById("volumeChart");
const byId = (id) => document.getElementById(id);
const PERIODS = ["daily", "weekly", "monthly"];
const DEFAULT_VISIBLE = Object.freeze({ daily: 100, weekly: 40, monthly: 18 });
const MIN_VISIBLE = Object.freeze({ daily: 20, weekly: 10, monthly: 6 });
const ZOOM_STEP = Object.freeze({ daily: 10, weekly: 5, monthly: 3 });
const visibleByPeriod = { ...DEFAULT_VISIBLE };

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || "服务器请求失败");
  return payload;
}

const money = (cents) => (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rate = (millionths) => `${(millionths / 10000).toFixed(2)}%`;

function colorMetric(element, value) {
  element.style.color = value > 0 ? "var(--red)" : value < 0 ? "var(--green)" : "#edf2f6";
}

function resize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const density = devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * density);
  canvas.height = Math.round(rect.height * density);
  const context = canvas.getContext("2d");
  context.scale(density, density);
  return [context, rect.width, rect.height];
}

function plotLine(context, values, color, x, y) {
  context.strokeStyle = color;
  context.lineWidth = 1.35;
  context.beginPath();
  let started = false;
  values.forEach((value, index) => {
    if (value === null || value === undefined) return;
    started ? context.lineTo(x(index), y(value)) : context.moveTo(x(index), y(value));
    started = true;
  });
  context.stroke();
}

function movingAverage(bars, length) {
  let sum = 0;
  return bars.map((bar, index) => {
    sum += bar.closeCents;
    if (index >= length) sum -= bars[index - length].closeCents;
    return index < length - 1 ? null : sum / length;
  });
}

function viewportFor(bars) {
  const visibleCount = Math.min(bars.length, visibleByPeriod[period]);
  return {
    visibleCount,
    shown: bars.slice(-visibleCount),
    offset: bars.length - visibleCount,
    blankSlots: Math.max(4, Math.min(16, Math.round(visibleCount * 0.1))),
  };
}

function referencePoints(bars) {
  const lowStart = Math.max(0, bars.length - 15);
  let lowIndex = lowStart;
  for (let index = lowStart + 1; index < bars.length; index += 1) {
    if (bars[index].lowCents < bars[lowIndex].lowCents) lowIndex = index;
  }
  if (lowIndex === 0) return { low: { index: 0, value: bars[0].lowCents }, high: null };
  const highStart = Math.max(0, lowIndex - 30);
  let highIndex = highStart;
  for (let index = highStart + 1; index < lowIndex; index += 1) {
    if (bars[index].highCents > bars[highIndex].highCents) highIndex = index;
  }
  return {
    low: { index: lowIndex, value: bars[lowIndex].lowCents },
    high: { index: highIndex, value: bars[highIndex].highCents },
  };
}

function drawPriceAxis(context, width, right, levels, y) {
  context.font = "11px 'DM Mono', monospace";
  context.textAlign = "right";
  context.textBaseline = "middle";
  levels.forEach(({ value, label, current }) => {
    if (current) return;
    const position = y(value);
    context.strokeStyle = current ? "#d6a62f" : "#3b84dc";
    context.lineWidth = current ? 1.2 : 0.8;
    context.setLineDash(current ? [7, 5] : [3, 5]);
    context.beginPath();
    context.moveTo(width - right - 70, position);
    context.lineTo(width - right + 2, position);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = current ? "#f4d546" : "#a8b8ca";
    context.fillText(label, width - 5, position);
  });
}

function drawSwing(context, point, name, offset, x, y, plotRight, labelDirection) {
  if (!point) return;
  const startX = x(Math.max(0, point.index - offset));
  const position = y(point.value);
  context.strokeStyle = "#f4d546";
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(startX, position);
  context.lineTo(Math.min(plotRight, startX + 110), position);
  context.stroke();
  context.font = "600 11px 'DM Mono', monospace";
  context.textAlign = "left";
  context.textBaseline = labelDirection < 0 ? "bottom" : "top";
  const label = `${name} ${money(point.value)}`;
  const labelX = startX + 3;
  const labelY = position + labelDirection * 4;
  const metrics = context.measureText(label);
  context.fillStyle = "rgba(13, 17, 23, .88)";
  context.fillRect(labelX - 2, labelDirection < 0 ? labelY - 14 : labelY - 1, metrics.width + 4, 15);
  context.fillStyle = "#f4d546";
  context.fillText(label, labelX, labelY);
}

function drawTrainingStart(context, shown, x, top, bottom) {
  const index = shown.findIndex((bar) => bar.isTrainingStart);
  if (index < 0) return null;
  const position = x(index);
  context.strokeStyle = "rgba(56, 189, 248, .92)";
  context.lineWidth = 1.2;
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(position, top);
  context.lineTo(position, bottom);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "rgba(13, 17, 23, .88)";
  context.fillRect(position - 26, bottom - 18, 52, 15);
  context.fillStyle = "#38bdf8";
  context.font = "600 10px 'DM Mono', monospace";
  context.textAlign = "center";
  context.textBaseline = "bottom";
  context.fillText("模拟起点", position, bottom - 4);
  return position;
}

function drawIndicatorPanel(bars, viewport) {
  const [context, width, height] = resize(vc);
  const left = 10;
  const right = 58;
  const top = 8;
  const bottom = 8;
  const step = (width - left - right) / (viewport.visibleCount + viewport.blankSlots);
  const x = (index) => left + index * step + step / 2;
  context.clearRect(0, 0, width, height);
  if (indicatorMode === "volume") {
    const maximum = Math.max(1, ...viewport.shown.map((bar) => bar.volume));
    viewport.shown.forEach((bar, index) => {
      const barHeight = bar.volume / maximum * (height - top - bottom);
      context.fillStyle = bar.closeCents >= bar.openCents ? "#f0445f" : "#11c98b";
      context.fillRect(x(index) - Math.max(1, step * 0.275), height - bottom - barHeight, Math.max(1, step * 0.55), barHeight);
    });
    const startIndex = viewport.shown.findIndex((bar) => bar.isTrainingStart);
    if (startIndex >= 0) {
      context.strokeStyle = "rgba(56, 189, 248, .72)";
      context.setLineDash([5, 5]);
      context.beginPath();
      context.moveTo(x(startIndex), top);
      context.lineTo(x(startIndex), height - bottom);
      context.stroke();
      context.setLineDash([]);
    }
    return;
  }
  const indicators = state.indicators[period];
  let series = [];
  if (indicatorMode === "macd") series = [[indicators.macd.map((item) => item.dif), "#f4d546"], [indicators.macd.map((item) => item.dea), "#4389ff"]];
  if (indicatorMode === "kdj") series = [[indicators.kdj.map((item) => item.k), "#f4d546"], [indicators.kdj.map((item) => item.d), "#4389ff"], [indicators.kdj.map((item) => item.j), "#d95ac2"]];
  if (indicatorMode === "rsi") series = [[indicators.rsi[6], "#f4d546"], [indicators.rsi[12], "#4389ff"], [indicators.rsi[24], "#d95ac2"]];
  const visibleSeries = series.map(([values, color]) => [values.slice(viewport.offset), color]);
  const values = visibleSeries.flatMap(([items]) => items.filter((value) => value !== null));
  if (indicatorMode === "macd") values.push(0);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(1, maximum - minimum);
  const y = (value) => top + (maximum - value) / range * (height - top - bottom);
  const baseline = indicatorMode === "macd" ? 0 : (minimum + maximum) / 2;
  context.strokeStyle = "#26303a";
  context.beginPath();
  context.moveTo(0, y(baseline));
  context.lineTo(width, y(baseline));
  context.stroke();
  if (indicatorMode === "macd") {
    indicators.macd.slice(viewport.offset).forEach((item, index) => {
      const base = y(0);
      const tip = y(item.histogram);
      context.fillStyle = item.histogram >= 0 ? "#f0445f" : "#11c98b";
      context.fillRect(x(index) - Math.max(1, step * 0.25), Math.min(base, tip), Math.max(1, step * 0.5), Math.max(1, Math.abs(base - tip)));
    });
  }
  visibleSeries.forEach(([items, color]) => plotLine(context, items, color, x, y));
}

function draw() {
  if (!state) return;
  const bars = state.bars[period];
  const viewport = viewportFor(bars);
  const [context, width, height] = resize(pc);
  const padding = { left: 10, right: 58, top: 20, bottom: 18 };
  const latest = viewport.shown.at(-1);
  const levels = [
    { value: latest.closeCents * 1.1, label: `+10% ${money(latest.closeCents * 1.1)}` },
    { value: latest.closeCents * 1.05, label: `+5% ${money(latest.closeCents * 1.05)}` },
    { value: latest.closeCents, label: money(latest.closeCents), current: true },
    { value: latest.closeCents * 0.95, label: `-5% ${money(latest.closeCents * 0.95)}` },
    { value: latest.closeCents * 0.9, label: `-10% ${money(latest.closeCents * 0.9)}` },
  ];
  const references = referencePoints(bars);
  const values = [...viewport.shown.flatMap((bar) => [bar.lowCents, bar.highCents]), ...levels.map((item) => item.value), references.low.value, ...(references.high ? [references.high.value] : [])];
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const margin = Math.max(1, (rawMaximum - rawMinimum) * 0.04);
  const minimum = rawMinimum - margin;
  const maximum = rawMaximum + margin;
  const range = Math.max(1, maximum - minimum);
  const step = (width - padding.left - padding.right) / (viewport.visibleCount + viewport.blankSlots);
  const x = (index) => padding.left + index * step + step / 2;
  const y = (value) => padding.top + (maximum - value) / range * (height - padding.top - padding.bottom);
  const plotRight = width - padding.right;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#26303a";
  [0.2, 0.5, 0.8].forEach((position) => {
    context.beginPath();
    context.moveTo(0, padding.top + position * (height - padding.top - padding.bottom));
    context.lineTo(plotRight, padding.top + position * (height - padding.top - padding.bottom));
    context.stroke();
  });
  viewport.shown.forEach((bar, index) => {
    const center = x(index);
    const color = bar.closeCents >= bar.openCents ? "#f0445f" : "#11c98b";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(center, y(bar.highCents));
    context.lineTo(center, y(bar.lowCents));
    context.stroke();
    context.fillRect(center - Math.max(1, step * 0.27), y(Math.max(bar.openCents, bar.closeCents)), Math.max(2, step * 0.54), Math.max(1, y(Math.min(bar.openCents, bar.closeCents)) - y(Math.max(bar.openCents, bar.closeCents))));
  });
  const settings = window.trainingIndicatorSettings?.get?.() || { periods: [5, 10, 20, 60, 100], enabled: [true, true, true, true, true] };
  const colors = window.trainingIndicatorSettings?.colors || ["#f4d546", "#4389ff", "#11c98b", "#f28c38", "#d95ac2"];
  settings.periods.forEach((length, index) => {
    if (!settings.enabled[index]) return;
    const calculated = window.trainingIndicatorSettings?.calculateMA?.(bars, length) || movingAverage(bars, length);
    plotLine(context, calculated.slice(viewport.offset), colors[index], x, y);
  });
  const trainingStartX = drawTrainingStart(context, viewport.shown, x, padding.top, height - padding.bottom);
  drawSwing(context, references.high, "前高", viewport.offset, x, y, plotRight, -1);
  drawSwing(context, references.low, "近15低", viewport.offset, x, y, plotRight, 1);
  drawPriceAxis(context, width, padding.right, levels, y);
  window.trainingChartLayout = { period, latestX: x(viewport.shown.length - 1), currentY: y(latest.closeCents), plotRight, trainingStartX, visibleCount: viewport.visibleCount, blankSlots: viewport.blankSlots };
  ["currentPrice", "priceTag", "closeVal"].forEach((id) => { byId(id).textContent = money(latest.closeCents); });
  byId("openVal").textContent = money(latest.openCents);
  byId("highVal").textContent = money(latest.highCents);
  byId("lowVal").textContent = money(latest.lowCents);
  byId("priceInput").value = money(latest.closeCents).replaceAll(",", "");
  drawIndicatorPanel(bars, viewport);
}

function zoomChart(direction) {
  const available = state?.bars?.[period]?.length || DEFAULT_VISIBLE[period];
  const current = Math.min(available, visibleByPeriod[period]);
  visibleByPeriod[period] = Math.max(MIN_VISIBLE[period], Math.min(available, current + direction * ZOOM_STEP[period]));
  draw();
}

function installChartControls() {
  const chart = document.querySelector(".chart-wrap");
  const reset = document.createElement("button");
  Object.assign(reset, { id: "resetChartView", className: "chart-reset", type: "button", title: "重置图表视图", textContent: "↺" });
  reset.setAttribute("aria-label", "重置图表视图");
  reset.onclick = () => { visibleByPeriod[period] = DEFAULT_VISIBLE[period]; draw(); };
  chart.appendChild(reset);
  chart.addEventListener("wheel", (event) => { event.preventDefault(); zoomChart(event.deltaY < 0 ? -1 : 1); }, { passive: false });
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "chart-viewport.css";
  document.head.appendChild(style);
}

function installWorkspaceLayout() {
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "workspace-layout.css";
  document.head.appendChild(style);
  const topActions = document.querySelector(".top-actions");
  const tradePanel = document.querySelector(".trade-panel");
  if (topActions && tradePanel) tradePanel.prepend(topActions);
}

function selectedPercent() { return Number(byId("positionSlider").value); }
function buyQuantity() { return Math.floor(state.maximumBuyQuantity * selectedPercent() / 100 / 100) * 100; }
function sellQuantity() {
  const available = state.position.availableQuantity;
  return selectedPercent() === 100 ? available : Math.floor(available * selectedPercent() / 100 / 100) * 100;
}
function syncQuantity() { byId("positionPct").textContent = `${selectedPercent()}%`; byId("quantityInput").value = buyQuantity(); }

function syncPerformance() {
  byId("winRate").textContent = state.performance.winRateMillionths === null ? "--" : rate(state.performance.winRateMillionths);
  byId("returnRate").textContent = rate(state.performance.returnRateMillionths);
  byId("totalProfit").textContent = money(state.performance.totalProfitCents);
  byId("profitLossRatio").textContent = state.performance.profitLossRatioMillionths === null ? "--" : (state.performance.profitLossRatioMillionths / 1_000_000).toFixed(2);
  byId("maximumDrawdown").textContent = rate(state.performance.maximumDrawdownMillionths);
  colorMetric(byId("returnRate"), state.performance.returnRateMillionths);
  colorMetric(byId("totalProfit"), state.performance.totalProfitCents);
  byId("maximumDrawdown").style.color = state.performance.maximumDrawdownMillionths > 0 ? "var(--green)" : "#edf2f6";
}

function render() {
  if (!state) { location.replace("random.html"); return; }
  document.querySelector(".instrument-row h1").innerHTML = `${state.stockName} <span class="ticker">${state.stockCode}</span>`;
  const latest = state.bars[period].at(-1);
  byId("dateLabel").textContent = state.datesRevealed ? (latest.tradeDate || latest.periodStart) : "日期已隐藏";
  document.querySelector(".bar-count").innerHTML = `<span id="barCount">${state.bars[period].length}</span> 根 · 剩余 ${state.advancesRemaining} 步`;
  byId("stepNumber").textContent = state.advancesCompleted;
  byId("cash").textContent = money(state.account.cashCents);
  byId("equity").textContent = money(state.account.equityCents);
  byId("holding").textContent = `${state.position.quantity.toLocaleString()} 股 / 可卖 ${state.position.availableQuantity.toLocaleString()} 股`;
  syncPerformance();
  Object.assign(byId("timeSlider"), { min: 0, max: state.simulationBars, value: state.advancesCompleted, disabled: true });
  const rollbackDisabled = state.advancesCompleted === 0 || state.position.quantity > 0 || state.status !== "running";
  byId("prevBtn").disabled = rollbackDisabled;
  byId("undoBtn").disabled = rollbackDisabled;
  byId("nextBtn").disabled = state.status !== "running";
  byId("observeBtn").disabled = state.status !== "running";
  byId("reviewBtn").hidden = state.status !== "finished";
  byId("buyBtn").disabled = state.status !== "running" || buyQuantity() === 0;
  byId("sellBtn").disabled = state.status !== "running" || state.position.availableQuantity === 0;
  byId("finishBtn").textContent = state.status === "running" ? "结束本局" : "下一局";
  byId("finishBtn").disabled = false;
  document.querySelector(".top-actions span:nth-child(2)").textContent = state.status === "running" ? "训练中" : "已完成";
  byId("trainingStatus").textContent = state.datesRevealed ? "训练完成，真实日期已公开" : "真实日期已隐藏";
  syncQuantity();
  byId("tradeCount").textContent = `共 ${state.fills.length} 笔`;
  byId("tradeList").innerHTML = state.fills.slice().reverse().map((fill) => `<div class="trade-item"><span class="${fill.side}">${fill.side === "buy" ? "买入" : "卖出"} ${fill.quantity.toLocaleString()}股</span><span>${money(fill.fillPriceCents)} · 费 ${money(fill.totalFeesCents)}</span></div>`).join("");
  draw();
  window.dispatchEvent(new CustomEvent("training-state-rendered"));
}

async function act(action) {
  [byId("prevBtn"), byId("nextBtn"), byId("observeBtn")].forEach((button) => { button.disabled = true; });
  try {
    state = await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: state.version }) });
    sessionStorage.setItem("randomTrainingState", JSON.stringify(state));
  } catch (error) { byId("trainingStatus").textContent = error.message; }
  render();
}

async function trade(side) {
  const quantity = side === "buy" ? buyQuantity() : sellQuantity();
  if (quantity <= 0) { byId("trainingStatus").textContent = side === "buy" ? "当前资金不足以买入100股" : "当前没有可卖持仓"; return; }
  try {
    state = await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}/trade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: state.version, side, quantity }) });
    sessionStorage.setItem("randomTrainingState", JSON.stringify(state));
    byId("trainingStatus").textContent = side === "buy" ? "买入成交" : "卖出成交";
  } catch (error) { byId("trainingStatus").textContent = error.message; }
  render();
}

async function startReview() {
  try {
    const review = await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}/reviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    location.href = `review.html?id=${encodeURIComponent(review.id)}&step=${review.startStep}`;
  } catch (error) { byId("trainingStatus").textContent = error.message; }
}

async function finishOrStartNext() {
  if (state.status !== "running") {
    const previousStockCode = state.stockCode;
    byId("finishBtn").disabled = true;
    byId("finishBtn").textContent = "创建中...";
    try {
      state = await requestJson("/api/random-training-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          simulationBars: state.simulationBars,
          initialCapitalCents: state.account.equityCents,
          excludeStockCode: previousStockCode,
        }),
      });
      sessionStorage.setItem("randomTrainingState", JSON.stringify(state));
      period = "daily";
      Object.assign(visibleByPeriod, DEFAULT_VISIBLE);
      render();
    } catch (error) {
      byId("trainingStatus").textContent = error.message;
      byId("finishBtn").disabled = false;
      byId("finishBtn").textContent = "下一局";
    }
    return;
  }
  if (!window.confirm("确认结束本局？当前持仓将按当前收盘价计入最终资产，不会自动卖出。")) return;
  try {
    state = await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: state.version }),
    });
    sessionStorage.setItem("randomTrainingState", JSON.stringify(state));
    render();
  } catch (error) {
    byId("trainingStatus").textContent = error.message;
  }
}

document.querySelectorAll(".chart-actions .ghost").forEach((button, index) => {
  if (index > 2) { button.hidden = true; return; }
  button.onclick = () => { period = PERIODS[index]; document.querySelectorAll(".chart-actions .ghost").forEach((item) => item.classList.remove("active")); button.classList.add("active"); render(); };
});
document.querySelectorAll(".indicator-modes button").forEach((button) => {
  button.onclick = () => { indicatorMode = button.dataset.indicator; document.querySelectorAll(".indicator-modes button").forEach((item) => item.classList.remove("active")); button.classList.add("active"); draw(); };
});
byId("nextBtn").onclick = () => act("advance");
byId("observeBtn").onclick = () => act("advance");
byId("undoBtn").onclick = () => act("rollback");
byId("prevBtn").onclick = () => act("rollback");
byId("buyBtn").onclick = () => trade("buy");
byId("sellBtn").onclick = () => trade("sell");
byId("reviewBtn").onclick = startReview;
const finishButton = document.querySelector(".control-buttons button:first-child");
finishButton.id = "finishBtn";
finishButton.textContent = "结束本局";
finishButton.onclick = finishOrStartNext;
byId("positionSlider").oninput = syncQuantity;
document.querySelectorAll(".fraction").forEach((button) => { button.onclick = () => { byId("positionSlider").value = Math.round(Number(button.dataset.fraction) * 100); syncQuantity(); }; });
document.querySelectorAll(".mode-tabs button,.direction-row .direction").forEach((button) => { button.disabled = true; button.style.opacity = ".45"; });
byId("quantityInput").disabled = true;
byId("priceInput").readOnly = true;
window.onresize = draw;
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!["ArrowUp", "ArrowDown"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return;
  event.preventDefault();
  zoomChart(event.key === "ArrowUp" ? -1 : 1);
});

installWorkspaceLayout();
installChartControls();
window.addEventListener("indicator-settings-changed", draw);

async function bootstrap() {
  if (!state?.id) { location.replace("random.html"); return; }
  try {
    state = await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}`);
    sessionStorage.setItem("randomTrainingState", JSON.stringify(state));
    render();
  } catch { sessionStorage.removeItem("randomTrainingState"); location.replace("random.html"); }
}
bootstrap();

for (const [href, source] of [["trade-panel-tabs.css", "trade-panel-tabs.js"], ["current-bar-details.css", "current-bar-details.js"]]) {
  const style = document.createElement("link");
  Object.assign(style, { rel: "stylesheet", href });
  document.head.appendChild(style);
  const script = document.createElement("script");
  script.src = source;
  document.body.appendChild(script);
}
