import assert from "node:assert/strict";
import test from "node:test";
import { createPatternService } from "../../src/application/pattern-service.mjs";
import { advanceTrainingSession, createTrainingSession, executeTrainingMarketOrder } from "../../src/domain/session/training-session.mjs";
import { openAppDatabase } from "../../src/infrastructure/app-database.mjs";
import { createPatternRepository } from "../../src/infrastructure/pattern-repository.mjs";
import { createReviewRepository } from "../../src/infrastructure/review-repository.mjs";
import { createTrainingSessionRepository } from "../../src/infrastructure/training-session-repository.mjs";

function marketBars() {
  return Array.from({ length: 400 }, (_, index) => ({
    tradeDate: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    openCents: 1000 + index, highCents: 1010 + index, lowCents: 990 + index, closeCents: 1000 + index,
    volume: 1000 + index, amountCents: 1_000_000 + index,
  }));
}

function completedSession() {
  let session = createTrainingSession({
    id: "pattern-session", stockCode: "600000", stockName: "浦发银行", bars: marketBars(),
    startIndex: 200, simulationBars: 150, initialCapitalCents: 10_000_000,
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

function setup() {
  const database = openAppDatabase(":memory:");
  const sessions = createTrainingSessionRepository(database);
  const source = completedSession();
  sessions.save(source);
  const reviews = createReviewRepository(database);
  reviews.create({ id: "review-1", sessionId: source.id, selectedFillId: "sell-fill", startStep: 0 });
  let nextId = 0;
  const service = createPatternService({
    repository: createPatternRepository(database), reviewRepository: reviews,
    loadSession: (id) => sessions.load(id, source.bars), idFactory: () => `generated-${++nextId}`,
  });
  return { database, service };
}

function input(category) {
  return {
    name: `${category}示例`, category, displayPeriod: "daily", triggerConditions: "价格突破并获得确认",
    klineFeatures: "阳线实体扩大", indicatorFeatures: "MA5上穿MA10", volumeFeatures: "温和放量",
    marketContext: "指数处于上升趋势", invalidationConditions: "跌破前低", riskNotes: "单次风险不超过2%", confidence: 4,
    evidence: { reviewId: "review-1", fillId: "sell-fill", startStep: 0, endStep: 2, note: "首次证据" },
  };
}

test("all four pattern categories persist with immutable evidence and statistics", () => {
  const { database, service } = setup();
  const categories = ["open_position", "add_position", "reduce_position", "close_position"];
  const created = categories.map((category) => service.create(input(category)));
  assert.deepEqual(created.map((item) => item.category), categories);
  assert.equal(created[0].statistics.evidenceCount, 1);
  assert.equal(created[0].statistics.completedEvidenceCount, 1);
  assert.equal(created[0].evidence[0].startStep, 0);

  const updated = service.update(created[0].id, { ...input("open_position"), name: "更新后的建仓模式" });
  assert.equal(updated.name, "更新后的建仓模式");
  assert.equal(updated.evidence[0].note, "首次证据");
  const withMoreEvidence = service.addEvidence(created[0].id, {
    reviewId: "review-1", startStep: 3, endStep: 5, note: "第二个片段",
  });
  assert.equal(withMoreEvidence.statistics.evidenceCount, 2);
  assert.equal(service.list("open_position").length, 1);
  assert.equal(service.list().length, 4);
  database.close();
});

test("pattern validation requires a valid category, conditions and historical evidence", () => {
  const { database, service } = setup();
  assert.throws(() => service.create({ ...input("open_position"), evidence: null }), (error) => error.code === "PATTERN_EVIDENCE_REQUIRED");
  assert.throws(() => service.create(input("unknown")), (error) => error.code === "INVALID_PATTERN_CATEGORY");
  assert.throws(() => service.create({ ...input("open_position"), triggerConditions: "" }), (error) => error.code === "INVALID_PATTERN");
  assert.throws(() => service.create({ ...input("open_position"), evidence: { reviewId: "review-1", startStep: 5, endStep: 151 } }),
    (error) => error.code === "REVIEW_STEP_NOT_FOUND");
  database.close();
});
