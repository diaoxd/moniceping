import assert from "node:assert/strict";
import test from "node:test";
import { selectRandomTrainingCandidate } from "../../../src/domain/session/random-candidate.mjs";

function bars(startYear, count) {
  const date = new Date(`${startYear}-01-01T00:00:00Z`);
  return Array.from({ length: count }, () => {
    const bar = { tradeDate: date.toISOString().slice(0, 10) };
    date.setUTCDate(date.getUTCDate() + 1);
    return bar;
  });
}

const stocks = [
  { stockCode: "000001", stockName: "深市样本", market: "SZ", boardType: "MAIN", bars: bars(2020, 700) },
  { stockCode: "600000", stockName: "沪市样本", market: "SH", boardType: "MAIN", bars: bars(2020, 700) },
  { stockCode: "900001", stockName: "未知样本", market: "UNKNOWN", boardType: "UNKNOWN", bars: bars(2020, 700) },
];

test("the same seed reproduces the same stock and start index", () => {
  const first = selectRandomTrainingCandidate({ stocks, simulationBars: 150, seed: "fixed-seed" });
  const second = selectRandomTrainingCandidate({ stocks, simulationBars: 150, seed: "fixed-seed" });
  assert.deepEqual(first, second);
  assert.ok(first.candidate.startTradeDate >= "2021-01-01");
  assert.notEqual(first.candidate.market, "UNKNOWN");
});

test("all eligible markets participate without a market filter", () => {
  const result = selectRandomTrainingCandidate({ stocks, simulationBars: 200, seed: "all-market" });
  assert.ok(result.candidateCount > 0);
  assert.ok(["SZ", "SH"].includes(result.candidate.market));
});

test("stocks without a full history and simulation window are excluded", () => {
  assert.throws(
    () => selectRandomTrainingCandidate({
      stocks: [{ stockCode: "000001", stockName: "不足", market: "SZ", boardType: "MAIN", bars: bars(2021, 349) }],
      simulationBars: 150,
      seed: "none",
    }),
    (error) => error.code === "NO_TRAINING_CANDIDATE",
  );
});
