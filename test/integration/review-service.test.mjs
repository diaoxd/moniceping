import assert from "node:assert/strict";
import test from "node:test";
import { createReviewService } from "../../src/application/review-service.mjs";
import { advanceTrainingSession, createTrainingSession, executeTrainingMarketOrder } from "../../src/domain/session/training-session.mjs";
import { openAppDatabase } from "../../src/infrastructure/app-database.mjs";
import { createReviewRepository } from "../../src/infrastructure/review-repository.mjs";
import { createTrainingSessionRepository } from "../../src/infrastructure/training-session-repository.mjs";

function bars(count = 400) {
  return Array.from({ length: count }, (_, index) => ({
    tradeDate: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    openCents: 1000 + index, highCents: 1010 + index, lowCents: 990 + index, closeCents: 1000 + index,
    volume: 1000 + index, amountCents: 1_000_000 + index,
  }));
}

function finishedSession() {
  let session = createTrainingSession({
    id: "reviewed-session", stockCode: "600000", stockName: "浦发银行", bars: bars(),
    startIndex: 200, simulationBars: 150, initialCapitalCents: 10_000_000, randomSeed: "review-seed",
  });
  session = executeTrainingMarketOrder(session, session.version, {
    id: "buy-order", fillId: "buy-fill", side: "buy", quantity: 100,
  });
  session = advanceTrainingSession(session, session.version);
  session = executeTrainingMarketOrder(session, session.version, {
    id: "sell-order", fillId: "sell-fill", side: "sell", quantity: 100,
  });
  while (session.status === "running") session = advanceTrainingSession(session, session.version);
  return session;
}

test("review replays immutable steps and persists notes and summary", () => {
  const database = openAppDatabase(":memory:");
  const sessions = createTrainingSessionRepository(database);
  const source = finishedSession();
  sessions.save(source);
  const repository = createReviewRepository(database);
  const service = createReviewService({ repository, loadSession: (id) => sessions.load(id, source.bars), idFactory: () => "review-1" });

  const review = service.create(source.id, { selectedFillId: "sell-fill" });
  assert.equal(review.startStep, 0);
  const initial = service.getStep(review.id, 0);
  const final = service.getStep(review.id, 150);
  assert.equal(initial.state.bars.daily.length, 200);
  assert.equal(final.state.bars.daily.length, 350);
  assert.equal(initial.state.datesRevealed, true);
  assert.equal(initial.state.position.quantity, 100);
  assert.equal(final.state.position.quantity, 0);

  service.saveStepNote(review.id, 0, "观察建仓后的风险暴露");
  service.saveSummary(review.id, "入场偏早，下一次等待趋势确认。");
  assert.equal(service.getStep(review.id, 0).note.content, "观察建仓后的风险暴露");
  assert.equal(repository.get(review.id).summary, "入场偏早，下一次等待趋势确认。");
  assert.equal(service.list(source.id).length, 1);
  database.close();
});

test("review rejects unfinished sessions, foreign fills, invalid steps and oversized notes", () => {
  const database = openAppDatabase(":memory:");
  const source = finishedSession();
  const repository = createReviewRepository(database);
  const sessions = new Map([[source.id, source], ["running", { ...source, id: "running", status: "running" }]]);
  database.prepare(`INSERT INTO training_sessions(id, stock_code, stock_name, simulation_bars, start_index,
    end_index, visible_index, advances_completed, version, status, initial_capital_cents, cash_cents,
    equity_cents, last_price_cents, position_quantity, available_quantity, total_cost_cents)
    VALUES ('reviewed-session','600000','浦发银行',150,200,349,349,150,1,'finished',10000000,10000000,10000000,1000,0,0,0)`).run();
  const service = createReviewService({ repository, loadSession: (id) => sessions.get(id), idFactory: () => "review-2" });
  assert.throws(() => service.create("running"), (error) => error.code === "SESSION_NOT_FINISHED");
  assert.throws(() => service.create(source.id, { selectedFillId: "other-fill" }), (error) => error.code === "FILL_NOT_FOUND");
  const review = service.create(source.id);
  assert.throws(() => service.getStep(review.id, 151), (error) => error.code === "REVIEW_STEP_NOT_FOUND");
  assert.throws(() => service.saveStepNote(review.id, 0, "x".repeat(2001)), (error) => error.code === "INVALID_REVIEW_NOTE");
  database.close();
});
