const $ = (id) => document.getElementById(id);
const money = (cents) =>
  cents == null
    ? "--"
    : (Number(cents) / 100).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const pct = (value) =>
  value == null ? "--" : `${(Number(value) / 10000).toFixed(2)}%`;
const ratio = (value) =>
  value == null ? "--" : (Number(value) / 1000000).toFixed(2);
const tone = (value) => (value > 0 ? "positive" : value < 0 ? "negative" : "");
const metric = (label, value, numeric = 0) =>
  `<div class="metric"><span>${label}</span><strong class="${tone(numeric)}">${value}</strong></div>`;
function tradingDuration(totalDays) {
  const years = Math.floor(totalDays / 250);
  const afterYears = totalDays % 250;
  const months = Math.floor(afterYears / 21);
  const days = afterYears % 21;
  return `${totalDays}日（${years}年 ${months}月 ${days}日）`;
}
function drawEquityCurve(points) {
  const canvas = $("equityCurve");
  const context = canvas.getContext("2d");
  const width = canvas.clientWidth;
  const height = 180;
  const density = devicePixelRatio || 1;
  canvas.width = Math.round(width * density);
  canvas.height = Math.round(height * density);
  context.scale(density, density);
  context.clearRect(0, 0, width, height);
  if (!points.length) return;
  const padding = { left: 12, right: 12, top: 12, bottom: 24 };
  const values = points.map((point) => point.equityCents);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(1, maximum - minimum);
  const x = (index) => padding.left + index / Math.max(1, points.length - 1) * (width - padding.left - padding.right);
  const y = (value) => padding.top + (maximum - value) / range * (height - padding.top - padding.bottom);
  context.strokeStyle = "#283646";
  context.lineWidth = 1;
  [0, 0.5, 1].forEach((ratio) => { context.beginPath(); context.moveTo(padding.left, padding.top + ratio * (height - padding.top - padding.bottom)); context.lineTo(width - padding.right, padding.top + ratio * (height - padding.top - padding.bottom)); context.stroke(); });
  context.strokeStyle = "#4389ff";
  context.lineWidth = 2;
  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(x(index), y(point.equityCents)) : context.moveTo(x(index), y(point.equityCents)));
  context.stroke();
  points.forEach((point, index) => { context.fillStyle = index === points.length - 1 ? "#f0445f" : "#8db4ff"; context.beginPath(); context.arc(x(index), y(point.equityCents), index === points.length - 1 ? 4 : 2.5, 0, Math.PI * 2); context.fill(); });
  context.fillStyle = "#8491a0";
  context.font = "11px monospace";
  context.textBaseline = "bottom";
  context.textAlign = "left";
  context.fillText(money(points[0].equityCents), padding.left, height - 2);
  context.textAlign = "right";
  context.fillText(money(points.at(-1).equityCents), width - padding.right, height - 2);
}
async function load() {
  try {
    const [summaryResponse, historyResponse] = await Promise.all([
      fetch("/api/training-dashboard"),
      fetch("/api/random-training-sessions?status=finished&limit=20&offset=0"),
    ]);
    const summary = await summaryResponse.json();
    const history = await historyResponse.json();
    if (!summaryResponse.ok)
      throw Error(summary.error?.message || "训练汇总加载失败");
    $("currentEquity").textContent = money(summary.currentEquityCents);
    $("summaryCaption").textContent =
      `初始资金 ${money(summary.startingCapitalCents)} · ${summary.trainingCount} 局有效训练`;
    $("primaryMetrics").innerHTML = [
      metric(
        "累计盈亏",
        money(summary.totalProfitCents),
        summary.totalProfitCents,
      ),
      metric(
        "累计收益率",
        pct(summary.returnRateMillionths),
        summary.returnRateMillionths,
      ),
      metric(
        "卖出胜率",
        pct(summary.winRateMillionths),
        summary.winRateMillionths,
      ),
      metric(
        "盈亏比",
        ratio(summary.profitLossRatioMillionths),
        summary.profitLossRatioMillionths,
      ),
      metric(
        "最大回撤",
        pct(summary.maximumDrawdownMillionths),
        -summary.maximumDrawdownMillionths,
      ),
    ].join("");
    $("secondaryMetrics").innerHTML = [
      metric("操作局数", String(summary.trainingCount)),
      metric("平仓次数", String(summary.operationCount)),
      metric(
        "最大单笔盈利",
        money(summary.maximumProfitCents),
        summary.maximumProfitCents,
      ),
      metric(
        "最大单笔亏损",
        money(summary.maximumLossCents),
        summary.maximumLossCents,
      ),
      metric(
        "单次期望收益",
        money(summary.expectancyCents),
        summary.expectancyCents,
      ),
      metric("成交笔数", String(summary.fillCount)),
      metric(
        "交易频率",
        summary.tradesPerHundredBarsMillionths == null
          ? "--"
          : `${(summary.tradesPerHundredBarsMillionths / 1000000).toFixed(2)} 笔/百根`,
      ),
      metric("累计交易时间", tradingDuration(summary.totalBars)),
      metric("初始资金", money(summary.startingCapitalCents)),
      metric("训练模式", "随机训练"),
    ].join("");
    $("curveChange").textContent = `${summary.totalProfitCents >= 0 ? "+" : ""}${money(summary.totalProfitCents)}`;
    drawEquityCurve(summary.equityCurve || []);
    const latest = history.items?.find((item) => item.advancesCompleted > 0);
    if (latest)
      $("latestReport").href =
        `report.html?id=${encodeURIComponent(latest.id)}`;
    if (summary.currentEquityCents != null)
      localStorage.setItem(
        "randomTrainingCapitalCents",
        String(summary.currentEquityCents),
      );
  } catch (error) {
    $("status").textContent = error.message;
  }
}
$("resetCapital").onclick = () => {
  localStorage.removeItem("randomTrainingCapitalCents");
  localStorage.setItem("randomTrainingCapitalReset", "true");
  location.href = "random.html";
};
load();
