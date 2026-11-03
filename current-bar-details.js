(function () {
  const chart = document.querySelector(".chart-wrap");
  const next = document.getElementById("nextBtn");
  if (!chart || !next) return;
  const legacyPriceTag = document.querySelector(".chart-overlay");
  if (legacyPriceTag) legacyPriceTag.hidden = true;
  const details = document.createElement("aside");
  details.className = "current-bar-details";
  chart.appendChild(details);
  const horizontalLine = document.createElement("div");
  horizontalLine.className = "current-price-line";
  horizontalLine.innerHTML = "<span></span>";
  chart.appendChild(horizontalLine);
  const latestLine = document.createElement("div");
  latestLine.className = "latest-bar-line";
  chart.appendChild(latestLine);
  const indicator = document.querySelector(".volume-wrap");
  const indicatorLine = document.createElement("div");
  indicatorLine.className = "latest-bar-line";
  indicator?.appendChild(indicatorLine);
  const money = (cents) => (Number(cents) / 100).toFixed(2);

  function activePeriod() {
    const buttons = [...document.querySelectorAll(".chart-actions .ghost")];
    const index = buttons.findIndex((button) => button.classList.contains("active"));
    return ["daily", "weekly", "monthly"][index < 0 ? 0 : index];
  }

  function render() {
    const state = JSON.parse(sessionStorage.getItem("randomTrainingState") || "null");
    const bars = state?.bars?.[activePeriod()] || [];
    const bar = bars.at(-1);
    if (!bar) return;
    const previous = bars.at(-2);
    const changeCents = previous ? bar.closeCents - previous.closeCents : 0;
    const changeRate = previous?.closeCents ? changeCents / previous.closeCents * 100 : 0;
    const turnover = bar.turnoverRateMillionths == null ? "暂无数据" : `${(bar.turnoverRateMillionths / 10000).toFixed(2)}%`;
    const changeClass = changeCents >= 0 ? "rise" : "fall";
    details.innerHTML = `<b>当前 K 线 <em>编号 ${bar.index ?? bars.length}</em></b><span>开 <strong>${money(bar.openCents)}</strong></span><span>高 <strong>${money(bar.highCents)}</strong></span><span>低 <strong>${money(bar.lowCents)}</strong></span><span>收 <strong>${money(bar.closeCents)}</strong></span><span>涨跌额 <strong class="${changeClass}">${changeCents >= 0 ? "+" : ""}${money(changeCents)}</strong></span><span>涨跌幅 <strong class="${changeClass}">${changeRate >= 0 ? "+" : ""}${changeRate.toFixed(2)}%</strong></span><span>成交量 <strong>${bar.volume.toLocaleString()}</strong></span><span>换手 <strong>${turnover}</strong></span>`;

    const layout = window.trainingChartLayout;
    const fallbackX = chart.clientWidth - 58;
    const fallbackY = chart.clientHeight / 2;
    const x = layout?.period === activePeriod() ? layout.latestX : fallbackX;
    const y = layout?.period === activePeriod() ? layout.currentY : fallbackY;
    horizontalLine.style.top = `${y}px`;
    horizontalLine.querySelector("span").textContent = money(bar.closeCents);
    latestLine.style.left = `${x}px`;
    indicatorLine.style.left = `${x}px`;
  }

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (event.key !== "ArrowRight" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return;
    event.preventDefault();
    if (!next.disabled) next.click();
  });
  setInterval(render, 200);
  render();
})();
