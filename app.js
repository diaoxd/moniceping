let state = JSON.parse(sessionStorage.getItem("randomTrainingState") || "null");
let period = "daily";
let indicatorMode = "volume";
let finishActionPending = false;
let selectedTradeSide = "buy";
let selectedAllocation = 0.2;
let selectedConditionSide = "buy";
let selectedTriggerDirection = "cross_up";

const pc = document.getElementById("priceChart");
const vc = document.getElementById("volumeChart");
const byId = (id) => document.getElementById(id);
const PERIODS = ["daily", "weekly", "monthly"];
const DEFAULT_VISIBLE = Object.freeze({ daily: 100, weekly: 40, monthly: 18 });
const MIN_VISIBLE = Object.freeze({ daily: 20, weekly: 10, monthly: 6 });
const ZOOM_STEP = Object.freeze({ daily: 10, weekly: 5, monthly: 3 });
const visibleByPeriod = { ...DEFAULT_VISIBLE };
const selectedIndexByPeriod = { daily: null, weekly: null, monthly: null };
const TRAINING_CAPITAL_KEY = "randomTrainingCapitalCents";

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "服务器请求失败");
    error.code = payload.error?.code || "REQUEST_FAILED";
    throw error;
  }
  return payload;
}

const money = (cents) => (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rate = (millionths) => `${(millionths / 10000).toFixed(2)}%`;

function latestPriceChange(bars) {
  if (bars.length < 2) return { amountCents: 0, percent: 0 };
  const latestClose = bars.at(-1).closeCents;
  const previousClose = bars.at(-2).closeCents;
  if (previousClose === 0) return { amountCents: 0, percent: 0 };
  return { amountCents: latestClose - previousClose, percent: (latestClose - previousClose) / previousClose * 100 };
}

function renderLatestPriceChange(bars) {
  const change = latestPriceChange(bars);
  const direction = change.amountCents > 0 ? "up" : change.amountCents < 0 ? "down" : "flat";
  const sign = change.amountCents > 0 ? "+" : "";
  const quote = document.querySelector(".quote");
  const price = byId("currentPrice");
  const changeLabel = quote.querySelector(".price-change, span");
  quote.dataset.direction = direction;
  price.className = direction;
  changeLabel.className = `price-change ${direction}`;
  changeLabel.textContent = `${sign}${change.percent.toFixed(2)}%`;
  changeLabel.title = `较前一${period === "daily" ? "日" : period === "weekly" ? "周" : "月"}收盘价${sign}${money(change.amountCents)}`;
}

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

function aggregateIndexForDailyOffset(periodBars, dailyOffset) {
  if (period === "daily") return dailyOffset;
  let sourceOffset = 0;
  for (let index = 0; index < periodBars.length; index += 1) {
    sourceOffset += periodBars[index].sourceCount;
    if (dailyOffset < sourceOffset) return index;
  }
  return -1;
}

function drawTradeMarkers(context, bars, viewport, x, y, top, bottom) {
  const dailyBars = state.bars.daily;
  const markers = state.fills.map((fill) => {
    const dailyOffset = dailyBars.findIndex((bar) => bar.index === fill.step);
    const absoluteIndex = dailyOffset < 0 ? -1 : aggregateIndexForDailyOffset(bars, dailyOffset);
    return { fill, absoluteIndex, visibleIndex: absoluteIndex - viewport.offset };
  }).filter((marker) => marker.visibleIndex >= 0 && marker.visibleIndex < viewport.shown.length);
  const groupSizes = new Map();
  markers.forEach((marker) => {
    const key = `${marker.absoluteIndex}:${marker.fill.side}`;
    groupSizes.set(key, (groupSizes.get(key) || 0) + 1);
  });
  const groupOffsets = new Map();
  const rendered = markers.map((marker) => {
    const key = `${marker.absoluteIndex}:${marker.fill.side}`;
    const ordinal = groupOffsets.get(key) || 0;
    groupOffsets.set(key, ordinal + 1);
    const count = groupSizes.get(key);
    const bar = bars[marker.absoluteIndex];
    const markerX = x(marker.visibleIndex) + (ordinal - (count - 1) / 2) * 17;
    const markerY = marker.fill.side === "buy"
      ? Math.min(bottom - 11, y(bar.lowCents) + 17)
      : Math.max(top + 11, y(bar.highCents) - 17);
    const color = marker.fill.side === "buy" ? "#f0445f" : "#11c98b";
    context.fillStyle = color;
    context.strokeStyle = "#0d1117";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(markerX, markerY, 10, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "#fff";
    context.font = "700 11px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(marker.fill.side === "buy" ? "B" : "S", markerX, markerY + 0.5);
    return { fillId: marker.fill.id, side: marker.fill.side, barIndex: marker.absoluteIndex, visibleIndex: marker.visibleIndex, x: markerX, y: markerY };
  });
  window.trainingTradeMarkers = rendered;
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
  const selectedAbsoluteIndex = selectedIndexByPeriod[period];
  const selectedBar = selectedAbsoluteIndex === null ? latest : bars[selectedAbsoluteIndex] || latest;
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
  const selectedVisibleIndex = selectedAbsoluteIndex === null ? -1 : selectedAbsoluteIndex - viewport.offset;
  let selectedStopLine = null;
  if (selectedVisibleIndex >= 0 && selectedVisibleIndex < viewport.shown.length) {
    const selected = viewport.shown[selectedVisibleIndex];
    const halfWidth = Math.max(5, step * 0.42);
    const top = y(selected.highCents) - 5;
    const bottom = y(selected.lowCents) + 5;
    context.strokeStyle = "#00b7ff";
    context.lineWidth = 2;
    context.strokeRect(x(selectedVisibleIndex) - halfWidth, top, halfWidth * 2, Math.max(12, bottom - top));
    if (selectedAbsoluteIndex < bars.length - 1) {
      const startX = x(selectedVisibleIndex);
      const endX = x(viewport.shown.length - 1);
      const stopY = y(selected.lowCents);
      context.strokeStyle = "rgba(155, 166, 178, .82)";
      context.lineWidth = 1.2;
      context.setLineDash([6, 5]);
      context.beginPath();
      context.moveTo(startX, stopY);
      context.lineTo(endX, stopY);
      context.stroke();
      context.setLineDash([]);
      const label = `最低 ${money(selected.lowCents)}`;
      context.font = "600 11px 'DM Mono', monospace";
      context.textAlign = "left";
      context.textBaseline = "top";
      const labelX = startX + 5;
      const labelY = stopY + 5;
      const labelWidth = context.measureText(label).width;
      context.fillStyle = "rgba(13, 17, 23, .88)";
      context.fillRect(labelX - 3, labelY - 2, labelWidth + 6, 16);
      context.fillStyle = "#a7b1bc";
      context.fillText(label, labelX, labelY);
      selectedStopLine = { startX, endX, y: stopY, priceCents: selected.lowCents, label, labelX, labelY };
    }
  }
  const trainingStartX = drawTrainingStart(context, viewport.shown, x, padding.top, height - padding.bottom);
  drawSwing(context, references.high, "前高", viewport.offset, x, y, plotRight, -1);
  drawSwing(context, references.low, "近15低", viewport.offset, x, y, plotRight, 1);
  drawTradeMarkers(context, bars, viewport, x, y, padding.top, height - padding.bottom);
  drawPriceAxis(context, width, padding.right, levels, y);
  window.trainingChartLayout = { period, firstX: x(0), step, offset: viewport.offset, shownCount: viewport.shown.length, latestX: x(viewport.shown.length - 1), currentY: y(latest.closeCents), plotRight, trainingStartX, selectedStopLine, visibleCount: viewport.visibleCount, blankSlots: viewport.blankSlots };
  window.trainingSelectedBar = selectedAbsoluteIndex === null ? null : { period, index: selectedAbsoluteIndex };
  ["currentPrice", "priceTag"].forEach((id) => { byId(id).textContent = money(latest.closeCents); });
  renderLatestPriceChange(bars);
  byId("openVal").textContent = money(selectedBar.openCents);
  byId("highVal").textContent = money(selectedBar.highCents);
  byId("lowVal").textContent = money(selectedBar.lowCents);
  byId("closeVal").textContent = money(selectedBar.closeCents);
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
  pc.addEventListener("click", (event) => {
    const layout = window.trainingChartLayout;
    if (!layout || layout.period !== period) return;
    const canvasX = event.clientX - pc.getBoundingClientRect().left;
    const visibleIndex = Math.round((canvasX - layout.firstX) / layout.step);
    if (visibleIndex < 0 || visibleIndex >= layout.shownCount) return;
    selectedIndexByPeriod[period] = layout.offset + visibleIndex;
    draw();
    window.dispatchEvent(new CustomEvent("training-state-rendered"));
  });
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
  const panelTitle = document.querySelector(".panel-title");
  if (topActions && panelTitle) panelTitle.insertBefore(topActions, panelTitle.querySelector(".step-label"));
}

function selectedPercent() { return selectedAllocation * 100; }
function buyQuantity() { return Math.floor(state.maximumBuyQuantity * selectedAllocation / 100) * 100; }
function sellQuantity() {
  const available = state.position.availableQuantity;
  return selectedAllocation === 1 ? available : Math.floor(available * selectedAllocation / 100) * 100;
}
function syncQuantity() {
  const percent = selectedPercent();
  byId("positionPct").textContent = `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
  byId("quantityInput").value = selectedTradeSide === "buy" ? buyQuantity() : sellQuantity();
  document.querySelectorAll(".direction-row .direction").forEach((button) => button.classList.toggle("active", button.dataset.side === selectedTradeSide));
}

function selectTradeSide(side) {
  selectedTradeSide = side;
  selectedAllocation = 1;
  byId("positionSlider").value = 100;
  document.querySelectorAll(".fraction").forEach((button) => button.classList.remove("active"));
  syncQuantity();
}

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
  if (!state) { location.replace("dashboard.html"); return; }
  document.querySelector(".instrument-row h1").innerHTML = `${state.stockName} <span class="ticker">${state.stockCode}</span>`;
  const latest = state.bars[period].at(-1);
  byId("dateLabel").textContent = state.datesRevealed ? (latest.tradeDate || latest.periodStart) : "日期已隐藏";
  document.querySelector(".bar-count").innerHTML = `<span id="barCount">${state.bars[period].length}</span> 根 · 剩余 ${state.advancesRemaining} 步`;
  byId("stepNumber").textContent = state.advancesCompleted;
  byId("cash").textContent = money(state.account.cashCents);
  byId("equity").textContent = money(state.account.equityCents);
  byId("holding").textContent = `${state.position.quantity.toLocaleString()} 股 / 可卖 ${state.position.availableQuantity.toLocaleString()} 股`;
  if (state.status === "finished") localStorage.setItem(TRAINING_CAPITAL_KEY, String(state.account.equityCents));
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
    selectedIndexByPeriod[period] = null;
  } catch (error) {
    byId("trainingStatus").textContent = error.message;
    if (error.code === "STOP_LOSS_REQUIRED") showStopLossRequired(error.message);
  }
  render();
}

function showStopLossRequired(message) {
  byId("stopLossRequiredMessage").textContent = message || "当前持仓尚未设置足额止损保护，不能推进K线。";
  byId("stopLossRequiredDialog").hidden = false;
  document.body.classList.add("dialog-open");
  byId("openStopLossOrder").focus();
}

function closeStopLossRequired() {
  byId("stopLossRequiredDialog").hidden = true;
  document.body.classList.toggle("dialog-open", !byId("finishDialog").hidden);
}

async function trade(side) {
  if (selectedTradeSide !== side) {
    byId("trainingStatus").textContent = `请先选择${side === "buy" ? "买入" : "卖出"}方向`;
    return;
  }
  const quantity = Number(byId("quantityInput").value);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    byId("trainingStatus").textContent = "请输入有效的正整数股票数量";
    return;
  }
  try {
    state = await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}/trade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: state.version, side, quantity }) });
    sessionStorage.setItem("randomTrainingState", JSON.stringify(state));
    render();
    byId("trainingStatus").textContent = side === "buy" ? "买入成交" : "卖出成交";
  } catch (error) { byId("trainingStatus").textContent = error.message; }
}

async function startReview() {
  try {
    const review = await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}/reviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    location.href = `review.html?id=${encodeURIComponent(review.id)}&step=${review.startStep}`;
  } catch (error) { byId("trainingStatus").textContent = error.message; }
}

function setFinishDialogOpen(open) {
  if (finishActionPending) return;
  byId("finishDialog").hidden = !open;
  document.body.classList.toggle("dialog-open", open);
  if (open) {
    byId("finishRemaining").textContent = state.advancesRemaining;
    byId("finishDialogStatus").textContent = "";
    byId("continueTraining").focus();
  } else {
    byId("openFinishDialog").focus();
  }
}

function setFinishActionPending(pending, label = "") {
  finishActionPending = pending;
  ["continueTraining", "startNextRound", "confirmExitTraining"].forEach((id) => { byId(id).disabled = pending; });
  if (pending) byId("finishDialogStatus").textContent = label;
}

async function finishCurrentSession() {
  if (state.status !== "running") return;
  state = await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}/finish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: state.version }),
  });
  sessionStorage.setItem("randomTrainingState", JSON.stringify(state));
  localStorage.setItem(TRAINING_CAPITAL_KEY, String(state.account.equityCents));
}

async function createNextRound() {
  if (finishActionPending) return;
  const previousStockCode = state.stockCode;
  setFinishActionPending(true, "正在保存本局并创建下一局...");
  try {
    await finishCurrentSession();
    const dashboard = await requestJson("/api/training-dashboard");
    const nextCapitalCents = dashboard.currentEquityCents ?? state.account.equityCents;
    state = await requestJson("/api/random-training-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          simulationBars: state.simulationBars,
          initialCapitalCents: nextCapitalCents,
          excludeStockCode: previousStockCode,
        }),
    });
    sessionStorage.setItem("randomTrainingState", JSON.stringify(state));
    localStorage.setItem(TRAINING_CAPITAL_KEY, String(nextCapitalCents));
    period = "daily";
    Object.assign(visibleByPeriod, DEFAULT_VISIBLE);
    Object.keys(selectedIndexByPeriod).forEach((key) => { selectedIndexByPeriod[key] = null; });
    setFinishActionPending(false);
    setFinishDialogOpen(false);
    render();
  } catch (error) {
    setFinishActionPending(false);
    byId("finishDialogStatus").textContent = error.message;
  }
}

async function confirmExitTraining() {
  if (finishActionPending) return;
  setFinishActionPending(true, "正在保存本局...");
  try {
    await finishCurrentSession();
    location.href = "dashboard.html";
  } catch (error) {
    setFinishActionPending(false);
    byId("finishDialogStatus").textContent = error.message;
  }
}

function finishOrStartNext() { setFinishDialogOpen(true); }

function setConditionalDialogOpen(open) {
  byId("conditionalOrderForm").hidden = !open;
  byId("marketOrderForm").hidden = open;
  document.querySelectorAll(".mode-tabs button").forEach((button) => button.classList.toggle("active", open ? button.dataset.orderMode === "conditional" : button.dataset.orderMode === "market"));
  if (!open) {
    byId("conditionalStatus").textContent = "";
    return;
  }
  document.querySelectorAll("[data-condition-side]").forEach((button) => button.classList.toggle("active", button.dataset.conditionSide === selectedConditionSide));
  document.querySelectorAll("[data-trigger-direction]").forEach((button) => button.classList.toggle("active", button.dataset.triggerDirection === selectedTriggerDirection));
  const latest = state.bars.daily.at(-1);
  if (!byId("conditionPrice").value) byId("conditionPrice").value = (latest.closeCents / 100).toFixed(2);
  if (!byId("conditionQuantity").value) byId("conditionQuantity").value = selectedConditionSide === "buy" ? state.maximumBuyQuantity : state.position.quantity;
  byId("conditionalStatus").textContent = "正在读取风控设置...";
  requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}/risk-settings`)
    .then((settings) => { byId("requireStopLoss").checked = settings.requireStopLoss; byId("conditionalStatus").textContent = ""; })
    .catch((error) => { byId("conditionalStatus").textContent = error.message; });
}

async function updateRiskSetting() {
  try {
    const settings = await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}/risk-settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requireStopLoss: byId("requireStopLoss").checked }),
    });
    byId("conditionalStatus").textContent = settings.requireStopLoss ? "强制止损已开启" : "强制止损已关闭";
  } catch (error) {
    byId("requireStopLoss").checked = !byId("requireStopLoss").checked;
    byId("conditionalStatus").textContent = error.message;
  }
}

async function createCondition() {
  const price = Number(byId("conditionPrice").value);
  const quantity = Number(byId("conditionQuantity").value);
  if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0) {
    byId("conditionalStatus").textContent = "请输入有效的监控价格和股票数量";
    return;
  }
  byId("createCondition").disabled = true;
  try {
    await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}/conditional-orders`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side: selectedConditionSide, triggerDirection: selectedTriggerDirection, triggerPriceCents: Math.round(price * 100), quantity }),
    });
    byId("trainingStatus").textContent = "条件单创建成功，将从下一根K线开始监控";
    byId("conditionalStatus").textContent = "条件单创建成功，可在“当前挂单”中查看";
    window.dispatchEvent(new CustomEvent("conditional-orders-changed"));
  } catch (error) { byId("conditionalStatus").textContent = error.message; }
  finally { byId("createCondition").disabled = false; }
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
byId("openFinishDialog").onclick = finishOrStartNext;
byId("continueTraining").onclick = () => setFinishDialogOpen(false);
byId("startNextRound").onclick = createNextRound;
byId("confirmExitTraining").onclick = confirmExitTraining;
byId("finishDialog").addEventListener("click", (event) => { if (event.target === byId("finishDialog")) setFinishDialogOpen(false); });
byId("closeStopLossRequired").onclick = closeStopLossRequired;
byId("openStopLossOrder").onclick = () => {
  closeStopLossRequired();
  selectedConditionSide = "sell";
  selectedTriggerDirection = "cross_down";
  byId("conditionQuantity").value = state.position.quantity;
  byId("conditionPrice").value = "";
  setConditionalDialogOpen(true);
};
byId("stopLossRequiredDialog").addEventListener("click", (event) => { if (event.target === byId("stopLossRequiredDialog")) closeStopLossRequired(); });
byId("positionSlider").oninput = () => {
  selectedAllocation = Number(byId("positionSlider").value) / 100;
  document.querySelectorAll(".fraction").forEach((button) => button.classList.remove("active"));
  syncQuantity();
};
document.querySelectorAll(".fraction").forEach((button) => {
  button.onclick = () => {
    selectedAllocation = Number(button.dataset.fraction);
    byId("positionSlider").value = Math.round(selectedAllocation * 100);
    document.querySelectorAll(".fraction").forEach((item) => item.classList.toggle("active", item === button));
    syncQuantity();
  };
});
document.querySelectorAll(".direction-row .direction").forEach((button) => { button.onclick = () => selectTradeSide(button.dataset.side); });
document.querySelectorAll(".mode-tabs button").forEach((button) => {
  button.onclick = () => {
    setConditionalDialogOpen(button.dataset.orderMode === "conditional");
  };
});
document.querySelectorAll("[data-condition-side]").forEach((button) => {
  button.onclick = () => {
    selectedConditionSide = button.dataset.conditionSide;
    document.querySelectorAll("[data-condition-side]").forEach((item) => item.classList.toggle("active", item === button));
    byId("conditionQuantity").value = selectedConditionSide === "buy" ? state.maximumBuyQuantity : state.position.quantity;
  };
});
document.querySelectorAll("[data-trigger-direction]").forEach((button) => {
  button.onclick = () => { selectedTriggerDirection = button.dataset.triggerDirection; document.querySelectorAll("[data-trigger-direction]").forEach((item) => item.classList.toggle("active", item === button)); };
});
byId("requireStopLoss").onchange = updateRiskSetting;
byId("createCondition").onclick = createCondition;
byId("cancelCondition").onclick = () => setConditionalDialogOpen(false);
Object.assign(byId("quantityInput"), { disabled: false, type: "number", min: "1", step: "100", inputMode: "numeric" });
byId("priceInput").readOnly = true;
window.onresize = draw;
document.addEventListener("keydown", (event) => {
  if (!byId("stopLossRequiredDialog").hidden) {
    if (event.key === "Escape") closeStopLossRequired();
    return;
  }
  if (!byId("finishDialog").hidden) {
    if (event.key === "Escape") setFinishDialogOpen(false);
    return;
  }
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
  if (!state?.id) { location.replace("dashboard.html"); return; }
  try {
    state = await requestJson(`/api/random-training-sessions/${encodeURIComponent(state.id)}`);
    sessionStorage.setItem("randomTrainingState", JSON.stringify(state));
    render();
  } catch { sessionStorage.removeItem("randomTrainingState"); location.replace("dashboard.html"); }
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
