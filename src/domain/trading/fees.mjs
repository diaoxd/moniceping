const RATE_DENOMINATOR = 1_000_000n;

export const DEFAULT_FEE_RULES = Object.freeze({
  commissionRateMillionths: 300,
  minimumCommissionCents: 500,
  stampTaxRateMillionths: 500,
  transferFeeRateMillionths: 10,
});

function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error(`${field}必须是非负安全整数`), { code: "INVALID_MONEY" });
  }
}

function roundRate(amountCents, rateMillionths) {
  const amount = BigInt(amountCents);
  const rate = BigInt(rateMillionths);
  return Number((amount * rate + RATE_DENOMINATOR / 2n) / RATE_DENOMINATOR);
}

export function calculateTradeFees({ side, grossAmountCents }, rules = DEFAULT_FEE_RULES) {
  if (side !== "buy" && side !== "sell") {
    throw Object.assign(new Error("交易方向必须是buy或sell"), { code: "INVALID_SIDE" });
  }
  assertNonNegativeInteger(grossAmountCents, "成交金额");

  const commission = Math.max(
    rules.minimumCommissionCents,
    roundRate(grossAmountCents, rules.commissionRateMillionths),
  );
  const stampTax = side === "sell"
    ? roundRate(grossAmountCents, rules.stampTaxRateMillionths)
    : 0;
  const transferFee = roundRate(grossAmountCents, rules.transferFeeRateMillionths);
  const totalFees = commission + stampTax + transferFee;

  return Object.freeze({
    grossAmountCents,
    commissionCents: commission,
    stampTaxCents: stampTax,
    transferFeeCents: transferFee,
    totalFeesCents: totalFees,
    cashChangeCents: side === "buy"
      ? -(grossAmountCents + totalFees)
      : grossAmountCents - totalFees,
  });
}
