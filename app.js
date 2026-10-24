const candles = Array.from({ length: 60 }, (_, i) => {
  const base = 5.04 + i * 0.004 + Math.sin(i / 3) * 0.12;
  const open = base + Math.sin(i * 1.7) * 0.045;
  const close = base + Math.cos(i * 1.25) * 0.052;
  return {
    date: `2024 / ${String(5 + Math.floor(i / 20)).padStart(2, "0")} / ${String(1 + (i % 20)).padStart(2, "0")}`,
    open,
    close,
    high: Math.max(open, close) + 0.045 + Math.abs(Math.sin(i)) * 0.025,
    low: Math.min(open, close) - 0.045 - Math.abs(Math.cos(i)) * 0.02,
    volume: 450 + Math.abs(Math.sin(i * 0.8)) * 1600 + Math.random() * 300,
  };
});

const SESSION_ID = "demo-session-01";
const SYMBOL = "159806";
const PERIOD = "1d";
const INITIAL_CAPITAL = 260664.59;
let visible = 42;
let cash = INITIAL_CAPITAL;
let shares = 0;
let trades = [];
let commissionRate = 0.002;
let insightTimer;

let insights = {};
const pc = document.getElementById("priceChart");
const vc = document.getElementById("volumeChart");
const elements = Object.fromEntries(
  [
    "positionSlider", "positionPct", "quantityInput", "priceInput", "holding",
    "cash", "equity", "tradeCount", "tradeList", "timeSlider", "prevBtn",
    "nextBtn", "buyBtn", "sellBtn", "observeBtn",
  ].map((id) => [id, document.getElementById(id)]),
);

function createInsightPanel() {
  const panel = document.createElement("section");
  panel.className = "insight-panel";
  panel.setAttribute("aria-labelledby", "insightTitle");
  panel.innerHTML = `
    <div class="insight-head">
      <div><span class="insight-icon" aria-hidden="true">♡</span><strong id="insightTitle">心得体会</strong><span id="insightDate" class="mono"></span></div>
      <span id="insightStatus" class="insight-status" role="status"></span>
    </div>
    <textarea id="insightInput" maxlength="500" placeholder="记录当天对走势、仓位或交易决策的心得体会…"></textarea>
    <div class="insight-actions">
      <span><b id="insightCount">0</b> / 500</span>
      <button id="deleteInsightBtn" class="delete-insight" type="button" hidden>删除</button>
      <button id="saveInsightBtn" class="save-insight" type="button">保存体会</button>
    </div>`;
  document.querySelector(".chart-section").append(panel);

  const style = document.createElement("style");
  style.textContent = `
    .insight-panel{margin-top:18px;border-top:1px solid var(--line);padding-top:16px}
    .insight-head,.insight-actions{display:flex;align-items:center;justify-content:space-between}
    .insight-head>div{display:flex;align-items:center;gap:8px;min-width:0}
    .insight-icon{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;background:#321c25;color:#ff7184;font-size:17px;flex:0 0 auto}
    .insight-head strong{font-size:12px}.insight-head .mono{font-size:10px;color:var(--muted)}
    .insight-status{min-height:16px;color:var(--green);font-size:10px}
    .insight-panel textarea{display:block;width:100%;height:76px;resize:vertical;margin-top:10px;padding:11px 12px;border:1px solid #34404d;border-radius:6px;background:#111820;color:var(--text);font:12px/1.6 Manrope,system-ui,sans-serif;outline:none}
    .insight-panel textarea:focus{border-color:var(--blue);box-shadow:0 0 0 2px rgba(67,137,255,.14)}
    .insight-panel textarea::placeholder{color:#526070}
    .insight-actions{justify-content:flex-end;gap:9px;margin-top:8px;color:#647182;font-size:10px}
    .insight-actions>span{margin-right:auto}.insight-actions button{height:30px;padding:0 13px;border-radius:6px;font-size:11px}
    .save-insight{border:1px solid var(--blue);background:#2459ba;color:#fff}.delete-insight{border:1px solid #4a3139;background:transparent;color:#dc7180}
    @media(max-width:560px){.insight-head{align-items:flex-start}.insight-head>div{flex-wrap:wrap}.insight-status{padding-top:4px}}
  `;
  document.head.append(style);

  return Object.fromEntries(
    ["insightDate", "insightStatus", "insightInput", "insightCount", "deleteInsightBtn", "saveInsightBtn"]
      .map((id) => [id, document.getElementById(id)]),
  );
}

const insightElements = createInsightPanel();

function createMatchingControls() {
  const panel = document.createElement("section");
  panel.className = "matching-settings";
  panel.innerHTML = `
    <div class="matching-settings-head"><span>涨跌停撮合限制</span><span id="matchingStatus" role="status"></span></div>
    <label><input id="blockBuyAtLimitUp" type="checkbox" checked><span>涨停不能买入</span></label>
    <label><input id="blockSellAtLimitDown" type="checkbox" checked><span>跌停不能卖出</span></label>
    <div id="tradeConfigLabel" class="trade-config-label">前复权 · 手续费 0.20%</div>`;
  document.querySelector(".position-block").before(panel);

  const style = document.createElement("style");
  style.textContent = `
    .matching-settings{display:grid;grid-template-columns:1fr 1fr;gap:9px 12px;margin-top:14px;padding:12px;border:1px solid #303a47;border-radius:6px;background:#131a22}
    .matching-settings-head{grid-column:1/-1;display:flex;justify-content:space-between;color:#8693a2;font-size:10px}
    .matching-settings-head span:last-child{color:var(--green)}
    .matching-settings label{display:flex;align-items:center;gap:7px;color:#b2bcc7;font-size:11px;cursor:pointer;white-space:nowrap}
    .matching-settings input{width:14px;height:14px;margin:0;accent-color:var(--blue)}
    .trade-config-label{grid-column:1/-1;padding-top:9px;border-top:1px solid #27313d;color:#6f7e8f;font:10px 'DM Mono',monospace}
    .order-buttons button:disabled,.matching-settings input:disabled,.insight-actions button:disabled{cursor:not-allowed;opacity:.55}
    @media(max-width:380px){.matching-settings{grid-template-columns:1fr}.matching-settings-head{grid-column:1}}
  `;
  document.head.append(style);
  return Object.fromEntries(
    ["blockBuyAtLimitUp", "blockSellAtLimitDown", "matchingStatus", "tradeConfigLabel"]
      .map((id) => [id, document.getElementById(id)]),
  );
}

const matchingElements = createMatchingControls();
let matchingStatusTimer;

function resize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const density = devicePixelRatio || 1;
  canvas.width = rect.width * density;
  canvas.height = rect.height * density;
  const context = canvas.getContext("2d");
  context.scale(density, density);
  return [context, rect.width, rect.height];
}

function draw() {
  const [context, width, height] = resize(pc);
  const shown = candles.slice(0, visible);
  const padding = { left: 10, right: 18, top: 20, bottom: 18 };
  const min = Math.min(...shown.map((item) => item.low)) - 0.03;
  const max = Math.max(...shown.map((item) => item.high)) + 0.03;
  const step = (width - padding.left - padding.right) / shown.length;
  const y = (value) => padding.top + ((max - value) / (max - min)) * (height - padding.top - padding.bottom);

  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#26303a";
  [0.2, 0.5, 0.8].forEach((position) => {
    context.beginPath();
    context.moveTo(0, padding.top + position * (height - padding.top - padding.bottom));
    context.lineTo(width, padding.top + position * (height - padding.top - padding.bottom));
    context.stroke();
  });

  shown.forEach((item, index) => {
    const x = padding.left + index * step + step / 2;
    context.strokeStyle = item.close >= item.open ? "#11c98b" : "#f0445f";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, y(item.high));
    context.lineTo(x, y(item.low));
    context.stroke();
    context.fillStyle = context.strokeStyle;
    context.fillRect(
      x - step * 0.27,
      y(Math.max(item.open, item.close)),
      Math.max(4, step * 0.54),
      Math.max(2, y(Math.min(item.open, item.close)) - y(Math.max(item.open, item.close))),
    );

    if (insights[item.date]) {
      context.fillStyle = "#ff7184";
      context.font = "600 13px Manrope, sans-serif";
      context.textAlign = "center";
      context.fillText("♥", x, Math.max(13, y(item.high) - 8));
    }
  });

  [[5, "#f4d546"], [10, "#4389ff"], [30, "#b92398"]].forEach(([period, color]) => {
    context.strokeStyle = color;
    context.lineWidth = 1.7;
    context.beginPath();
    shown.forEach((item, index) => {
      const average = shown.slice(Math.max(0, index - period + 1), index + 1)
        .reduce((sum, value) => sum + value.close, 0) / Math.min(period, index + 1);
      const x = padding.left + index * step + step / 2;
      index ? context.lineTo(x, y(average)) : context.moveTo(x, y(average));
    });
    context.stroke();
  });

  const current = shown.at(-1);
  ["currentPrice", "priceTag", "closeVal"].forEach((id) => {
    document.getElementById(id).textContent = current.close.toFixed(2);
  });
  document.getElementById("openVal").textContent = current.open.toFixed(2);
  document.getElementById("highVal").textContent = current.high.toFixed(2);
  document.getElementById("lowVal").textContent = current.low.toFixed(2);
  document.getElementById("dateLabel").textContent = current.date;
  document.getElementById("barCount").textContent = visible;
  document.getElementById("stepNumber").textContent = visible;
  elements.priceInput.value = current.close.toFixed(2);

  const [volumeContext, volumeWidth, volumeHeight] = resize(vc);
  const maxVolume = Math.max(...shown.map((item) => item.volume));
  volumeContext.clearRect(0, 0, volumeWidth, volumeHeight);
  shown.forEach((item, index) => {
    volumeContext.fillStyle = item.close >= item.open ? "#11c98b" : "#f0445f";
    const x = 10 + index * ((volumeWidth - 28) / shown.length) + (volumeWidth - 28) / shown.length / 2;
    const barWidth = Math.max(3, ((volumeWidth - 28) / shown.length) * 0.55);
    const barHeight = (item.volume / maxVolume) * (volumeHeight - 20);
    volumeContext.fillRect(x - barWidth / 2, volumeHeight - 8 - barHeight, barWidth, barHeight);
  });
}

function syncAccount() {
  const percentage = Number(elements.positionSlider.value);
  elements.positionPct.textContent = `${percentage}%`;
  elements.quantityInput.value = Math.floor((cash * percentage / 100) / (Number(elements.priceInput.value) * (1 + commissionRate)) / 100) * 100;
  elements.holding.textContent = `${(shares * Number(elements.priceInput.value) / INITIAL_CAPITAL * 100).toFixed(2)}%`;
  elements.cash.textContent = cash.toLocaleString("en-US", { minimumFractionDigits: 2 });
  elements.equity.textContent = (cash + shares * Number(elements.priceInput.value)).toLocaleString("en-US", { minimumFractionDigits: 2 });
  elements.tradeCount.textContent = `共 ${trades.length} 笔`;
}

function showMatchingStatus(message, isError = false) {
  clearTimeout(matchingStatusTimer);
  matchingElements.matchingStatus.textContent = message;
  matchingElements.matchingStatus.style.color = isError ? "var(--red)" : "var(--green)";
  matchingStatusTimer = setTimeout(() => { matchingElements.matchingStatus.textContent = ""; }, 2600);
}

async function loadMatchingSettings() {
  try {
    const settings = await requestJson(`/api/training-sessions/${encodeURIComponent(SESSION_ID)}/matching-settings`);
    matchingElements.blockBuyAtLimitUp.checked = settings.blockBuyAtLimitUp;
    matchingElements.blockSellAtLimitDown.checked = settings.blockSellAtLimitDown;
  } catch (error) {
    showMatchingStatus(error.message, true);
  }
}

async function loadTradeConfig() {
  try {
    const config = await requestJson(`/api/training-sessions/${encodeURIComponent(SESSION_ID)}/trade-config`);
    commissionRate = config.commissionRate;
    const adjustLabel = config.adjustType === "pre" ? "前复权" : config.adjustType === "post" ? "后复权" : "不复权";
    matchingElements.tradeConfigLabel.textContent = `${adjustLabel} · 手续费 ${(commissionRate * 100).toFixed(2)}%`;
    syncAccount();
  } catch (error) {
    showMatchingStatus(error.message, true);
  }
}

async function saveMatchingSettings() {
  const controls = [matchingElements.blockBuyAtLimitUp, matchingElements.blockSellAtLimitDown];
  controls.forEach((control) => { control.disabled = true; });
  try {
    await requestJson(`/api/training-sessions/${encodeURIComponent(SESSION_ID)}/matching-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blockBuyAtLimitUp: matchingElements.blockBuyAtLimitUp.checked,
        blockSellAtLimitDown: matchingElements.blockSellAtLimitDown.checked,
      }),
    });
    showMatchingStatus("已保存");
  } catch (error) {
    showMatchingStatus(error.message, true);
    await loadMatchingSettings();
  } finally {
    controls.forEach((control) => { control.disabled = false; });
  }
}

async function trade(side) {
  const price = Number(elements.priceInput.value);
  const quantity = Number(elements.quantityInput.value);
  if (side === "sell" && shares < quantity) {
    showMatchingStatus("可卖持仓不足", true);
    return;
  }

  elements.buyBtn.disabled = true;
  elements.sellBtn.disabled = true;
  try {
    const matched = await requestJson(`/api/training-sessions/${encodeURIComponent(SESSION_ID)}/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        side,
        price,
        quantity,
        previousClose: candles[Math.max(0, visible - 2)].close,
      }),
    });
    if (side === "buy" && cash + matched.cashChange < 0) {
      showMatchingStatus("可用资金不足（含手续费）", true);
      return;
    }
    cash += matched.cashChange;
    shares += side === "buy" ? quantity : -quantity;
    trades.push({ side, price: matched.fillPrice, quantity, commission: matched.commission });
  } catch (error) {
    showMatchingStatus(error.message, true);
    return;
  } finally {
    elements.buyBtn.disabled = false;
    elements.sellBtn.disabled = false;
  }

  elements.tradeList.innerHTML = trades.slice().reverse().map((item) => `
    <div class="trade-item"><span class="${item.side}">${item.side === "buy" ? "买入" : "卖出"} ${item.quantity.toLocaleString()}股</span><span>${item.price.toFixed(2)} · 费 ${item.commission.toFixed(2)}</span></div>
  `).join("");
  syncAccount();
  showMatchingStatus("撮合成功");
}

function currentDate() {
  return candles[visible - 1].date;
}

function showInsightStatus(message) {
  clearTimeout(insightTimer);
  insightElements.insightStatus.textContent = message;
  insightTimer = setTimeout(() => { insightElements.insightStatus.textContent = ""; }, 1800);
}

function syncInsight() {
  const date = currentDate();
  const note = insights[date] || "";
  insightElements.insightDate.textContent = date;
  insightElements.insightInput.value = note;
  insightElements.insightCount.textContent = note.length;
  insightElements.deleteInsightBtn.hidden = !note;
  insightElements.insightStatus.textContent = "";
}

function insightUrl(tradeDate = "") {
  const datePath = tradeDate ? `/${encodeURIComponent(tradeDate)}` : "";
  return `/api/training-sessions/${encodeURIComponent(SESSION_ID)}/insights${datePath}?symbol=${encodeURIComponent(SYMBOL)}&period=${encodeURIComponent(PERIOD)}`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message || "服务器请求失败");
  }
  return response.status === 204 ? null : response.json();
}

async function loadInsights() {
  try {
    const result = await requestJson(insightUrl());
    insights = Object.fromEntries(result.items.map((item) => [item.tradeDate, item.content]));
    syncInsight();
    draw();
  } catch (error) {
    showInsightStatus(error.message);
  }
}

async function saveInsight() {
  const note = insightElements.insightInput.value.trim();
  if (!note) {
    showInsightStatus("请输入心得体会");
    insightElements.insightInput.focus();
    return;
  }
  const tradeDate = currentDate();
  insightElements.saveInsightBtn.disabled = true;
  try {
    const saved = await requestJson(insightUrl(tradeDate), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: note }),
    });
    insights[tradeDate] = saved.content;
    insightElements.insightInput.value = saved.content;
    insightElements.insightCount.textContent = saved.content.length;
    insightElements.deleteInsightBtn.hidden = false;
    showInsightStatus("已保存到数据库");
    draw();
  } catch (error) {
    showInsightStatus(error.message);
  } finally {
    insightElements.saveInsightBtn.disabled = false;
  }
}

function changeVisible(nextVisible) {
  visible = Math.max(18, Math.min(59, nextVisible));
  elements.timeSlider.value = visible;
  draw();
  syncAccount();
  syncInsight();
}

elements.timeSlider.oninput = (event) => changeVisible(Number(event.target.value));
elements.prevBtn.onclick = () => changeVisible(visible - 1);
elements.nextBtn.onclick = () => changeVisible(visible + 1);
elements.positionSlider.oninput = syncAccount;
elements.buyBtn.onclick = () => trade("buy");
elements.sellBtn.onclick = () => trade("sell");
matchingElements.blockBuyAtLimitUp.onchange = saveMatchingSettings;
matchingElements.blockSellAtLimitDown.onchange = saveMatchingSettings;
elements.observeBtn.onclick = elements.nextBtn.onclick;
document.querySelectorAll(".direction").forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll(".direction").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  };
});
document.querySelectorAll(".fraction").forEach((button) => {
  button.onclick = () => {
    elements.positionSlider.value = Number(button.dataset.fraction) * 100;
    syncAccount();
  };
});
insightElements.insightInput.oninput = () => {
  insightElements.insightCount.textContent = insightElements.insightInput.value.length;
};
insightElements.insightInput.onkeydown = (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveInsight();
};
insightElements.saveInsightBtn.onclick = saveInsight;
insightElements.deleteInsightBtn.onclick = async () => {
  const tradeDate = currentDate();
  insightElements.deleteInsightBtn.disabled = true;
  try {
    await requestJson(insightUrl(tradeDate), { method: "DELETE" });
    delete insights[tradeDate];
    syncInsight();
    showInsightStatus("已从数据库删除");
    draw();
  } catch (error) {
    showInsightStatus(error.message);
  } finally {
    insightElements.deleteInsightBtn.disabled = false;
  }
};
window.onresize = draw;

draw();
syncAccount();
syncInsight();
loadInsights();
loadMatchingSettings();
loadTradeConfig();
