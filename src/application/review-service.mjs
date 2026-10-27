import { randomUUID } from "node:crypto";
import { getPublicTrainingState } from "../domain/session/training-session.mjs";

function reviewError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireReview(repository, reviewId) {
  const review = repository.get(reviewId);
  if (!review) throw reviewError("REVIEW_NOT_FOUND", "复盘不存在");
  return review;
}

function validateContent(content, maximum, code, label, allowEmpty = false) {
  if (typeof content !== "string") throw reviewError(code, `${label}必须是文本`);
  const normalized = content.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maximum) {
    throw reviewError(code, `${label}须为${allowEmpty ? "0" : "1"}至${maximum}个字符`);
  }
  return normalized;
}

export function createReviewService({ repository, loadSession, idFactory = randomUUID }) {
  if (!repository || typeof loadSession !== "function") throw new Error("复盘仓储和训练会话加载器不能为空");
  function sessionFor(review) {
    const session = loadSession(review.sessionId);
    if (!session) throw reviewError("TRAINING_SESSION_NOT_FOUND", "训练会话不存在");
    return session;
  }
  function assertStep(session, step) {
    if (!Number.isSafeInteger(step) || step < 0 || step >= session.snapshots.length) {
      throw reviewError("REVIEW_STEP_NOT_FOUND", "复盘步骤不存在或超出快照范围");
    }
  }
  return Object.freeze({
    create(sessionId, { selectedFillId = null } = {}) {
      const session = loadSession(sessionId);
      if (!session) throw reviewError("TRAINING_SESSION_NOT_FOUND", "训练会话不存在");
      if (session.status !== "finished") throw reviewError("SESSION_NOT_FINISHED", "训练结束后才能创建复盘");
      let startStep = 0;
      if (selectedFillId !== null) {
        const fill = session.fills.find((item) => item.id === selectedFillId);
        if (!fill) throw reviewError("FILL_NOT_FOUND", "所选成交不属于该训练会话");
        startStep = Math.max(0, fill.step - 1);
      }
      return repository.create({ id: idFactory(), sessionId, selectedFillId, startStep });
    },
    list(sessionId) {
      if (!loadSession(sessionId)) throw reviewError("TRAINING_SESSION_NOT_FOUND", "训练会话不存在");
      return repository.listBySession(sessionId);
    },
    getStep(reviewId, step) {
      const review = requireReview(repository, reviewId);
      const session = sessionFor(review);
      assertStep(session, step);
      const historical = session.snapshots[step];
      const historicalSession = Object.freeze({
        ...session,
        visibleIndex: historical.visibleIndex,
        advancesCompleted: historical.advancesCompleted,
        status: "finished",
        account: historical.account,
        position: historical.position,
        orders: historical.orders,
        fills: historical.fills,
        snapshots: Object.freeze(session.snapshots.slice(0, step + 1)),
      });
      return Object.freeze({
        review,
        step,
        minimumStep: 0,
        maximumStep: session.snapshots.length - 1,
        note: repository.getStepNote(reviewId, step),
        state: getPublicTrainingState(historicalSession),
      });
    },
    saveStepNote(reviewId, step, content) {
      const review = requireReview(repository, reviewId);
      assertStep(sessionFor(review), step);
      return repository.saveStepNote(reviewId, step, validateContent(content, 2000, "INVALID_REVIEW_NOTE", "步骤笔记"));
    },
    saveSummary(reviewId, content) {
      requireReview(repository, reviewId);
      return repository.saveSummary(reviewId, validateContent(content, 5000, "INVALID_REVIEW_SUMMARY", "复盘总结", true));
    },
  });
}
