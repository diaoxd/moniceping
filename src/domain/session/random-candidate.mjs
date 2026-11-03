import { ALLOWED_SIMULATION_BARS, HISTORY_CONTEXT_BARS } from "./training-session.mjs";

function hashSeed(seed) {
  const text = String(seed);
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function createRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function selectRandomTrainingRange({ ranges, simulationBars, seed }) {
  if (!ALLOWED_SIMULATION_BARS.includes(simulationBars)) {
    throw Object.assign(new Error("模拟区间只能是150或200根"), { code: "INVALID_SIMULATION_BARS" });
  }
  if (!Array.isArray(ranges)) {
    throw Object.assign(new Error("候选区间列表无效"), { code: "INVALID_CANDIDATE_SOURCE" });
  }
  const candidateCount = ranges.reduce((total, range) => total + Number(range?.eligibleCount || 0), 0);
  if (candidateCount <= 0) {
    throw Object.assign(new Error("没有满足200根上下文和模拟区间要求的候选"), { code: "NO_TRAINING_CANDIDATE" });
  }
  let offset = Math.floor(createRandom(seed)() * candidateCount);
  for (const range of ranges) {
    const eligibleCount = Number(range?.eligibleCount || 0);
    if (offset >= eligibleCount) {
      offset -= eligibleCount;
      continue;
    }
    return Object.freeze({
      candidate: Object.freeze({
        stockCode: range.stockCode,
        stockName: range.stockName,
        market: range.market,
        boardType: range.boardType,
        startIndex: Number(range.firstStartIndex) + offset,
        simulationBars,
        seed: String(seed),
      }),
      candidateCount,
    });
  }
  throw Object.assign(new Error("候选区间统计无效"), { code: "INVALID_CANDIDATE_SOURCE" });
}

export function selectRandomTrainingCandidate({
  stocks,
  simulationBars,
  seed,
  minimumStartDate = "2021-01-01",
}) {
  if (!ALLOWED_SIMULATION_BARS.includes(simulationBars)) {
    throw Object.assign(new Error("模拟区间只能是150或200根"), { code: "INVALID_SIMULATION_BARS" });
  }
  if (!Array.isArray(stocks)) throw Object.assign(new Error("候选股票列表无效"), { code: "INVALID_CANDIDATE_SOURCE" });
  const random = createRandom(seed);
  let selected = null;
  let candidateCount = 0;

  for (const stock of stocks) {
    if (!stock || stock.market === "UNKNOWN" || !Array.isArray(stock.bars)) continue;
    const lastStartIndex = stock.bars.length - simulationBars;
    for (let startIndex = HISTORY_CONTEXT_BARS; startIndex <= lastStartIndex; startIndex += 1) {
      const bar = stock.bars[startIndex];
      if (!bar || bar.tradeDate < minimumStartDate) continue;
      candidateCount += 1;
      if (random() < 1 / candidateCount) {
        selected = Object.freeze({
          stockCode: stock.stockCode,
          stockName: stock.stockName,
          market: stock.market,
          boardType: stock.boardType,
          startIndex,
          startTradeDate: bar.tradeDate,
          simulationBars,
          seed: String(seed),
        });
      }
    }
  }
  if (!selected) throw Object.assign(new Error("没有满足200根上下文和模拟区间要求的候选"), { code: "NO_TRAINING_CANDIDATE" });
  return Object.freeze({ candidate: selected, candidateCount });
}
