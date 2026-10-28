(function () {
  const tabs = [...document.querySelectorAll(".panel-tabs button")];
  const empty = document.querySelector(".empty-state");
  const history = document.querySelector(".history");
  if (tabs.length !== 4 || !empty || !history) return;
  const view = document.createElement("section");
  view.className = "trade-tab-view"; view.hidden = true; history.before(view);
  const money = (cents) => (Number(cents) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const state = () => JSON.parse(sessionStorage.getItem("randomTrainingState") || "null");
  function show(html) { empty.hidden = true; history.hidden = true; view.hidden = false; view.innerHTML = html; }
  function position(data) {
    if (!data.position.quantity) { empty.hidden = false; history.hidden = false; view.hidden = true; return; }
    show(`<div class="tab-row"><span>持仓数量</span><strong>${data.position.quantity.toLocaleString()} 股</strong></div><div class="tab-row"><span>可卖数量</span><strong>${data.position.availableQuantity.toLocaleString()} 股</strong></div><div class="tab-row"><span>持仓成本</span><strong>${money(data.position.totalCostCents)}</strong></div>`);
  }
  function orders(data) {
    const pending = data.orders.filter((order) => order.status !== "filled");
    show(pending.length ? pending.map((order) => `<div class="tab-row"><span>${order.side === "buy" ? "买入" : "卖出"}</span><strong>${order.quantity} 股</strong></div>`).join("") : "<div class='tab-empty'>当前没有挂单</div>");
  }
  function details(data) {
    show(data.fills.length ? data.fills.slice().reverse().map((fill) => `<div class="tab-row"><span class="${fill.side}">${fill.side === "buy" ? "买入" : "卖出"} ${fill.quantity.toLocaleString()} 股</span><strong>${money(fill.fillPriceCents)}<small>费用 ${money(fill.totalFeesCents)}</small></strong></div>`).join("") : "<div class='tab-empty'>暂无成交明细</div>");
  }
  async function curve(data) {
    show("<canvas id='panelEquityCurve'></canvas><div id='curveStatus' class='tab-empty'>加载中...</div>");
    try {
      const response = await fetch(`/api/random-training-sessions/${encodeURIComponent(data.id)}/equity-curve`);
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || "资金曲线加载失败");
      const canvas = document.getElementById("panelEquityCurve"), status = document.getElementById("curveStatus");
      status.textContent = `共 ${payload.items.length} 个资产快照`;
      const width = canvas.clientWidth || 300, height = 170, density = devicePixelRatio || 1;
      canvas.width = width * density; canvas.height = height * density;
      const context = canvas.getContext("2d"); context.scale(density, density);
      const values = payload.items.map((item) => item.equityCents), minimum = Math.min(...values), maximum = Math.max(...values), range = Math.max(1, maximum - minimum);
      context.strokeStyle = "#4389ff"; context.lineWidth = 2; context.beginPath();
      values.forEach((value, index) => { const x = 8 + index / Math.max(1, values.length - 1) * (width - 16), y = 8 + (maximum - value) / range * (height - 20); index ? context.lineTo(x, y) : context.moveTo(x, y); });
      context.stroke();
    } catch (error) { document.getElementById("curveStatus").textContent = error.message; }
  }
  function activate(index) {
    tabs.forEach((tab, tabIndex) => tab.classList.toggle("active", tabIndex === index));
    const data = state(); if (!data) return;
    if (index === 0) position(data); else if (index === 1) orders(data); else if (index === 2) details(data); else curve(data);
  }
  tabs.forEach((tab, index) => { tab.onclick = () => activate(index); });
})();
