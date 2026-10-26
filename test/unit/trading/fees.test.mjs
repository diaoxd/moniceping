import assert from "node:assert/strict";
import test from "node:test";
import { calculateTradeFees } from "../../../src/domain/trading/fees.mjs";

test("buy charges minimum commission and transfer fee but no stamp tax", () => {
  assert.deepEqual(calculateTradeFees({ side: "buy", grossAmountCents: 1_000_000 }), {
    grossAmountCents: 1_000_000,
    commissionCents: 500,
    stampTaxCents: 0,
    transferFeeCents: 10,
    totalFeesCents: 510,
    cashChangeCents: -1_000_510,
  });
});

test("sell charges commission, stamp tax and transfer fee", () => {
  assert.deepEqual(calculateTradeFees({ side: "sell", grossAmountCents: 1_000_000 }), {
    grossAmountCents: 1_000_000,
    commissionCents: 500,
    stampTaxCents: 500,
    transferFeeCents: 10,
    totalFeesCents: 1_010,
    cashChangeCents: 998_990,
  });
});

test("commission scales above the five-yuan minimum", () => {
  const fees = calculateTradeFees({ side: "sell", grossAmountCents: 10_000_000 });
  assert.equal(fees.commissionCents, 3_000);
  assert.equal(fees.stampTaxCents, 5_000);
  assert.equal(fees.transferFeeCents, 100);
  assert.equal(fees.totalFeesCents, 8_100);
  assert.equal(fees.cashChangeCents, 9_991_900);
});

test("rates round to the nearest cent without binary floating-point settlement", () => {
  const fees = calculateTradeFees({ side: "sell", grossAmountCents: 1_001_001 });
  assert.equal(fees.commissionCents, 500);
  assert.equal(fees.stampTaxCents, 501);
  assert.equal(fees.transferFeeCents, 10);
});

test("invalid side and money inputs are rejected with stable error codes", () => {
  assert.throws(
    () => calculateTradeFees({ side: "short", grossAmountCents: 100_000 }),
    (error) => error.code === "INVALID_SIDE",
  );
  assert.throws(
    () => calculateTradeFees({ side: "buy", grossAmountCents: 12.5 }),
    (error) => error.code === "INVALID_MONEY",
  );
});
