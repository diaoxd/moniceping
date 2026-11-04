const query = new URLSearchParams(location.search);
const reviewId = query.get("id");
let step = Number(query.get("step") || 0);
let period = "daily";
let payload;
const byId = (id) => document.getElementById(id);
const money = (cents) => (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rate = (millionths) => `${(millionths / 10000).toFixed(2)}%`;

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || "请求失败");
  return body;
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

function aggregateIndexForDailyOffset(periodBars, dailyOffset) {
  if (period === "daily") return dailyOffset;
  let sourceOffset = 0;
  for (let index = 0; index < periodBars.length; index += 1) {
    sourceOffset += periodBars[index].sourceCount;
    if (dailyOffset < sourceOffset) return index;
  }
  return -1;
}

function drawTradeMarkers(context, periodBars, visibleOffset, barWidth, padding, y) {
  const dailyBars = payload.state.bars.daily;
  const markers = payload.state.fills.map((fill) => {
    const dailyOffset = dailyBars.findIndex((bar) => bar.index === fill.step);
    const periodIndex = dailyOffset < 0 ? -1 : aggregateIndexForDailyOffset(periodBars, dailyOffset);
    return { fill, visibleIndex: periodIndex - visibleOffset };
  }).filter(({ visibleIndex }) => visibleIndex >= 0 && visibleIndex < periodBars.length - visibleOffset);
  const stacked = new Map();
  markers.forEach(({ fill, visibleIndex }) => {
    const key = `${visibleIndex}:${fill.side}`;
    const ordinal = stacked.get(key) || 0;
    stacked.set(key, ordinal + 1);
    const bar = periodBars[visibleOffset + visibleIndex];
    const x = padding.left + visibleIndex * barWidth + barWidth / 2 + ordinal * 16;
    const markerY = fill.side === "buy" ? y(bar.lowCents) + 16 : y(bar.highCents) - 16;
    const color = fill.side === "buy" ? "#f0445f" : "#11c98b";
    context.fillStyle = color; context.strokeStyle = "#0d1117"; context.lineWidth = 2;
    context.beginPath(); context.arc(x, markerY, 10, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = "#fff"; context.font = "700 11px system-ui"; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(fill.side === "buy" ? "B" : "S", x, markerY);
    const quantity = `${fill.quantity.toLocaleString()}股`;
    context.font = "600 11px system-ui"; context.textAlign = "left";
    const labelWidth = context.measureText(quantity).width;
    const labelX = Math.min(x + 13, padding.width - padding.right - labelWidth - 4);
    context.fillStyle = "rgba(13,17,23,.88)"; context.fillRect(labelX - 3, markerY - 8, labelWidth + 6, 16);
    context.fillStyle = color; context.fillText(quantity, labelX, markerY);
  });
  window.reviewTradeMarkers = markers.map(({ fill, visibleIndex }) => ({ fillId: fill.id, side: fill.side, quantity: fill.quantity, visibleIndex }));
}

function draw() {
  if (!payload) return;
  const canvas = byId("reviewChart");
  const allBars = payload.state.bars[period];
  const visibleOffset = Math.max(0, allBars.length - 200);
  const bars = allBars.slice(visibleOffset);
  const [context, width, height] = resize(canvas);
  const padding = { left: 12, right: 90, top: 30, bottom: 30, width };
  const minimum = Math.min(...bars.map((bar) => bar.lowCents));
  const maximum = Math.max(...bars.map((bar) => bar.highCents));
  const range = Math.max(1, maximum - minimum);
  const barWidth = (width - padding.left - padding.right) / bars.length;
  const y = (value) => padding.top + (maximum - value) / range * (height - padding.top - padding.bottom);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#26303a";
  [0.25, 0.5, 0.75].forEach((position) => {
    context.beginPath(); context.moveTo(0, height * position); context.lineTo(width, height * position); context.stroke();
  });
  bars.forEach((bar, index) => {
    const x = padding.left + index * barWidth + barWidth / 2;
    const color = bar.closeCents >= bar.openCents ? "#f0445f" : "#11c98b";
    context.strokeStyle = color; context.fillStyle = color;
    context.beginPath(); context.moveTo(x, y(bar.highCents)); context.lineTo(x, y(bar.lowCents)); context.stroke();
    context.fillRect(x - Math.max(1, barWidth * 0.27), y(Math.max(bar.openCents, bar.closeCents)), Math.max(2, barWidth * 0.54), Math.max(1, Math.abs(y(bar.openCents) - y(bar.closeCents))));
  });
  drawTradeMarkers(context, allBars, visibleOffset, barWidth, padding, y);
}

function renderTradeSummary(fills) {
  byId("tradeSummaryCount").textContent = `${fills.length} 笔`;
  byId("tradeSummaryBody").innerHTML = fills.length ? fills.map((fill) => `<tr><td>第 ${fill.step} 步</td><td><span class="trade-side ${fill.side}">${fill.side === "buy" ? "买入" : "卖出"}</span></td><td>${fill.quantity.toLocaleString()} 股</td><td>${money(fill.fillPriceCents)}</td><td>${money(fill.totalFeesCents)}</td><td class="${fill.realizedProfitCents > 0 ? "profit" : fill.realizedProfitCents < 0 ? "loss" : ""}">${fill.side === "sell" ? money(fill.realizedProfitCents) : "--"}</td></tr>`).join("") : `<tr><td colspan="6" class="empty-cell">截至当前步骤暂无交易</td></tr>`;
}

function render() {
  const state = payload.state;
  const latest = state.bars[period].at(-1);
  byId("instrument").textContent = `${state.stockName} ${state.stockCode}`;
  byId("stepLabel").textContent = `第 ${payload.step} / ${payload.maximumStep} 步`;
  byId("dateLabel").textContent = latest.tradeDate || latest.periodStart;
  byId("stepSlider").min = payload.minimumStep;
  byId("stepSlider").max = payload.maximumStep;
  byId("stepSlider").value = payload.step;
  byId("previousStep").disabled = payload.step <= payload.minimumStep;
  byId("nextStep").disabled = payload.step >= payload.maximumStep;
  byId("equity").textContent = money(state.account.equityCents);
  byId("cash").textContent = money(state.account.cashCents);
  byId("position").textContent = `${state.position.quantity.toLocaleString()} 股`;
  byId("returnRate").textContent = rate(state.performance.returnRateMillionths);
  byId("stepNote").value = payload.note?.content || "";
  byId("summary").value = payload.review.summary || "";
  const fills = state.fills.filter((fill) => fill.step === payload.step);
  byId("tradeStrip").textContent = fills.length === 0 ? "该步骤暂无成交" : fills.map((fill) => `${fill.side === "buy" ? "买入" : "卖出"} ${fill.quantity}股 @ ${money(fill.fillPriceCents)}`).join(" · ");
  renderTradeSummary(state.fills);
  draw();
}

async function loadStep(nextStep) {
  try {
    payload = await requestJson(`/api/reviews/${encodeURIComponent(reviewId)}/steps/${nextStep}`);
    step = payload.step;
    history.replaceState(null, "", `review.html?id=${encodeURIComponent(reviewId)}&step=${step}`);
    render();
  } catch (error) { byId("status").textContent = error.message; }
}

byId("previousStep").onclick = () => loadStep(step - 1);
byId("nextStep").onclick = () => loadStep(step + 1);
byId("stepSlider").onchange = (event) => loadStep(Number(event.target.value));
document.querySelectorAll(".periods button").forEach((button) => button.onclick = () => {
  period = button.dataset.period;
  document.querySelectorAll(".periods button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  render();
});
byId("saveNote").onclick = async () => {
  try {
    await requestJson(`/api/reviews/${encodeURIComponent(reviewId)}/steps/${step}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: byId("stepNote").value }) });
    byId("status").textContent = "步骤笔记已保存";
  } catch (error) { byId("status").textContent = error.message; }
};
byId("saveSummary").onclick = async () => {
  try {
    payload.review = await requestJson(`/api/reviews/${encodeURIComponent(reviewId)}/summary`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: byId("summary").value }) });
    byId("status").textContent = "整体总结已保存";
  } catch (error) { byId("status").textContent = error.message; }
};
byId("savePattern").onclick = async () => {
  try {
    const fill = payload.state.fills.find((item) => item.step === step);
    const pattern = await requestJson("/api/trading-patterns", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: byId("patternName").value,
        category: byId("patternCategory").value,
        displayPeriod: period,
        triggerConditions: byId("patternTrigger").value,
        klineFeatures: "", indicatorFeatures: "", volumeFeatures: "", marketContext: "",
        invalidationConditions: byId("patternInvalidation").value,
        riskNotes: "", confidence: Number(byId("patternConfidence").value),
        evidence: {
          reviewId, fillId: fill?.id || null, startStep: Math.max(payload.minimumStep, step - 5),
          endStep: step, note: payload.note?.content || "",
        },
      }),
    });
    byId("status").textContent = `模式“${pattern.name}”已保存，证据 ${pattern.statistics.evidenceCount} 条`;
  } catch (error) { byId("status").textContent = error.message; }
};
window.onresize = draw;
if (!reviewId) location.replace("random.html"); else loadStep(step);
