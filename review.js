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

function draw() {
  if (!payload) return;
  const canvas = byId("reviewChart");
  const bars = payload.state.bars[period].slice(-200);
  const [context, width, height] = resize(canvas);
  const padding = { left: 12, right: 20, top: 20, bottom: 20 };
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
