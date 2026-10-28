(function () {
  const chart = document.querySelector(".chart-wrap");
  const next = document.getElementById("nextBtn");
  if (!chart || !next) return;
  const details = document.createElement("aside");
  details.className = "current-bar-details";
  chart.appendChild(details);
  const money = (cents) => (Number(cents) / 100).toFixed(2);

  function activePeriod() {
    const buttons = [...document.querySelectorAll(".chart-actions .ghost")];
    const index = buttons.findIndex((button) => button.classList.contains("active"));
    return ["daily", "weekly", "monthly"][index < 0 ? 0 : index];
  }

  function render() {
    const state = JSON.parse(sessionStorage.getItem("randomTrainingState") || "null");
    const bar = state?.bars?.[activePeriod()]?.at(-1);
    if (!bar) return;
    const turnover = bar.turnoverRateMillionths == null ? "暂无数据" : `${(bar.turnoverRateMillionths / 10000).toFixed(2)}%`;
    details.innerHTML = `<b>当前 K 线</b><span>开 ${money(bar.openCents)}</span><span>高 ${money(bar.highCents)}</span><span>低 ${money(bar.lowCents)}</span><span>收 ${money(bar.closeCents)}</span><span>换手 ${turnover}</span>`;
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
