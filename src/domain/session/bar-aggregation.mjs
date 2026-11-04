function parseTradeDate(tradeDate) {
  if (typeof tradeDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw Object.assign(new Error("交易日期必须使用YYYY-MM-DD格式"), { code: "INVALID_TRADE_DATE" });
  }
  const date = new Date(`${tradeDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== tradeDate) {
    throw Object.assign(new Error("交易日期无效"), { code: "INVALID_TRADE_DATE" });
  }
  return date;
}

function weekKey(tradeDate) {
  const date = parseTradeDate(tradeDate);
  const day = date.getUTCDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return date.toISOString().slice(0, 10);
}

function aggregate(bars, keyForBar) {
  const groups = [];
  for (const bar of bars) {
    const key = keyForBar(bar);
    const current = groups.at(-1);
    if (!current || current.key !== key) {
      groups.push({
        key,
        openCents: bar.openCents,
        highCents: bar.highCents,
        lowCents: bar.lowCents,
        closeCents: bar.closeCents,
        volume: bar.volume,
        amountCents: bar.amountCents,
        turnoverRateMillionths: bar.turnoverRateMillionths ?? null,
        turnoverDataComplete: bar.turnoverRateMillionths != null,
        sourceCount: 1,
      });
      continue;
    }
    current.highCents = Math.max(current.highCents, bar.highCents);
    current.lowCents = Math.min(current.lowCents, bar.lowCents);
    current.closeCents = bar.closeCents;
    current.volume += bar.volume;
    current.amountCents += bar.amountCents;
    if (current.turnoverDataComplete && bar.turnoverRateMillionths != null) {
      current.turnoverRateMillionths += bar.turnoverRateMillionths;
    } else {
      current.turnoverDataComplete = false;
      current.turnoverRateMillionths = null;
    }
    current.sourceCount += 1;
  }
  return groups;
}

export function aggregateWeeklyBars(bars) {
  return aggregate(bars, (bar) => weekKey(bar.tradeDate));
}

export function aggregateMonthlyBars(bars) {
  return aggregate(bars, (bar) => {
    parseTradeDate(bar.tradeDate);
    return bar.tradeDate.slice(0, 7);
  });
}
