function rounded(value) {
  return Number(value.toFixed(4));
}

function movingAverage(values, period) {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    return index < period - 1 ? null : rounded(sum / period);
  });
}

function ema(values, period) {
  const alpha = 2 / (period + 1);
  let previous = values[0];
  return values.map((value, index) => {
    previous = index === 0 ? value : alpha * value + (1 - alpha) * previous;
    return previous;
  });
}

function rsi(values, period) {
  let gains = 0;
  let losses = 0;
  return values.map((value, index) => {
    if (index === 0) return null;
    const change = value - values[index - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
    if (index > period) {
      const expired = values[index - period] - values[index - period - 1];
      gains -= Math.max(0, expired);
      losses -= Math.max(0, -expired);
    }
    if (index < period) return null;
    if (losses === 0) return 100;
    return rounded(100 - 100 / (1 + gains / losses));
  });
}

export function calculateTechnicalIndicators(bars) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return Object.freeze({ ma: Object.freeze({}), macd: Object.freeze([]), kdj: Object.freeze([]), rsi: Object.freeze({}) });
  }
  const closes = bars.map((bar) => bar.closeCents);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const diffs = closes.map((_, index) => ema12[index] - ema26[index]);
  const signals = ema(diffs, 9);
  let k = 50;
  let d = 50;
  const kdj = bars.map((bar, index) => {
    const window = bars.slice(Math.max(0, index - 8), index + 1);
    const low = Math.min(...window.map((item) => item.lowCents));
    const high = Math.max(...window.map((item) => item.highCents));
    const rsv = high === low ? 50 : (bar.closeCents - low) / (high - low) * 100;
    k = k * 2 / 3 + rsv / 3;
    d = d * 2 / 3 + k / 3;
    return Object.freeze({ k: rounded(k), d: rounded(d), j: rounded(3 * k - 2 * d) });
  });
  return Object.freeze({
    ma: Object.freeze(Object.fromEntries([5, 10, 20, 60, 100].map((period) => [period, Object.freeze(movingAverage(closes, period))]))),
    macd: Object.freeze(diffs.map((diff, index) => Object.freeze({
      dif: rounded(diff), dea: rounded(signals[index]), histogram: rounded(2 * (diff - signals[index])),
    }))),
    kdj: Object.freeze(kdj),
    rsi: Object.freeze(Object.fromEntries([6, 12, 24].map((period) => [period, Object.freeze(rsi(closes, period))]))),
  });
}
