import assert from "node:assert/strict";
import test from "node:test";
import { aggregateMonthlyBars, aggregateWeeklyBars } from "../../../src/domain/session/bar-aggregation.mjs";

function bar(tradeDate, turnoverRateMillionths) {
  return { tradeDate, openCents: 100, highCents: 110, lowCents: 90, closeCents: 105,
    volume: 1000, amountCents: 100000, turnoverRateMillionths };
}

test("weekly and monthly bars sum turnover only when every visible day has data", () => {
  const complete = [bar("2024-01-02", 10000), bar("2024-01-03", 25000)];
  assert.equal(aggregateWeeklyBars(complete)[0].turnoverRateMillionths, 35000);
  assert.equal(aggregateMonthlyBars(complete)[0].turnoverRateMillionths, 35000);
  const incomplete = [...complete, bar("2024-01-04", null)];
  assert.equal(aggregateWeeklyBars(incomplete)[0].turnoverRateMillionths, null);
  assert.equal(aggregateWeeklyBars(incomplete)[0].turnoverDataComplete, false);
});
