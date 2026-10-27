import assert from "node:assert/strict";
import test from "node:test";
import { calculateTechnicalIndicators } from "../../../src/domain/indicators/technical-indicators.mjs";

function bars(count) {
  return Array.from({ length: count }, (_, index) => ({
    openCents: 1000 + index, highCents: 1020 + index, lowCents: 990 + index,
    closeCents: 1010 + index, volume: 1000, amountCents: 100000,
  }));
}

test("technical indicators align one output with every visible bar", () => {
  const result = calculateTechnicalIndicators(bars(120));
  assert.equal(result.ma[5].length, 120);
  assert.equal(result.ma[5][3], null);
  assert.equal(result.ma[5][4], 1012);
  assert.equal(result.ma[100][98], null);
  assert.equal(result.macd.length, 120);
  assert.equal(result.kdj.length, 120);
  assert.equal(result.rsi[6].length, 120);
  assert.equal(result.rsi[6].at(-1), 100);
});

test("future bars never change indicators already exposed", () => {
  const prefix = calculateTechnicalIndicators(bars(80));
  const extended = calculateTechnicalIndicators(bars(120));
  assert.deepEqual(extended.ma[20].slice(0, 80), prefix.ma[20]);
  assert.deepEqual(extended.macd.slice(0, 80), prefix.macd);
  assert.deepEqual(extended.kdj.slice(0, 80), prefix.kdj);
  assert.deepEqual(extended.rsi[24].slice(0, 80), prefix.rsi[24]);
});

test("empty input returns empty indicator collections", () => {
  const result = calculateTechnicalIndicators([]);
  assert.deepEqual(result.macd, []);
  assert.deepEqual(result.kdj, []);
});
