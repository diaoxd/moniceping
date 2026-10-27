import { randomUUID } from "node:crypto";

const CATEGORIES = new Set(["open_position", "add_position", "reduce_position", "close_position"]);
const PERIODS = new Set(["daily", "weekly", "monthly"]);

function patternError(code, message) { return Object.assign(new Error(message), { code }); }
function text(value, label, maximum = 2000, required = false) {
  if (typeof value !== "string") throw patternError("INVALID_PATTERN", `${label}必须是文本`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) {
    throw patternError("INVALID_PATTERN", `${label}须为${required ? "1" : "0"}至${maximum}个字符`);
  }
  return normalized;
}

export function createPatternService({ repository, reviewRepository, loadSession, idFactory = randomUUID }) {
  function normalizePattern(input, existing = {}) {
    const values = { ...existing, ...input };
    if (!CATEGORIES.has(values.category)) throw patternError("INVALID_PATTERN_CATEGORY", "交易模式分类无效");
    if (!PERIODS.has(values.displayPeriod)) throw patternError("INVALID_DISPLAY_PERIOD", "适用周期无效");
    const confidence = Number(values.confidence);
    if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) throw patternError("INVALID_PATTERN", "信心等级必须为1至5");
    return Object.freeze({
      name: text(values.name, "模式名称", 100, true), category: values.category, displayPeriod: values.displayPeriod,
      triggerConditions: text(values.triggerConditions, "触发条件", 2000, true),
      klineFeatures: text(values.klineFeatures || "", "K线特征"),
      indicatorFeatures: text(values.indicatorFeatures || "", "指标特征"),
      volumeFeatures: text(values.volumeFeatures || "", "成交量特征"),
      marketContext: text(values.marketContext || "", "市场背景"),
      invalidationConditions: text(values.invalidationConditions, "失效条件", 2000, true),
      riskNotes: text(values.riskNotes || "", "风险说明"), confidence,
    });
  }
  function normalizeEvidence(input) {
    if (!input || typeof input !== "object") throw patternError("PATTERN_EVIDENCE_REQUIRED", "交易模式必须关联历史片段");
    const review = reviewRepository.get(input.reviewId);
    if (!review) throw patternError("REVIEW_NOT_FOUND", "复盘不存在");
    const session = loadSession(review.sessionId);
    if (!session) throw patternError("TRAINING_SESSION_NOT_FOUND", "训练会话不存在");
    const startStep = Number(input.startStep);
    const endStep = Number(input.endStep);
    if (!Number.isSafeInteger(startStep) || !Number.isSafeInteger(endStep) || startStep < 0
      || endStep < startStep || endStep >= session.snapshots.length) {
      throw patternError("REVIEW_STEP_NOT_FOUND", "证据片段超出复盘步骤范围");
    }
    const fillId = input.fillId || null;
    if (fillId && !session.fills.some((fill) => fill.id === fillId)) throw patternError("FILL_NOT_FOUND", "证据成交不属于该训练会话");
    return Object.freeze({
      id: idFactory(), reviewId: review.id, sessionId: review.sessionId, fillId,
      startStep, endStep, note: text(input.note || "", "证据说明"),
    });
  }
  return Object.freeze({
    create(input) {
      const evidence = normalizeEvidence(input.evidence);
      return repository.create({ id: idFactory(), ...normalizePattern(input) }, evidence);
    },
    update(id, input) {
      const existing = repository.get(id);
      if (!existing) throw patternError("PATTERN_NOT_FOUND", "交易模式不存在");
      return repository.update(id, normalizePattern(input, existing));
    },
    list(category = null) {
      if (category !== null && !CATEGORIES.has(category)) throw patternError("INVALID_PATTERN_CATEGORY", "交易模式分类无效");
      return repository.list(category);
    },
    addEvidence(id, input) {
      if (!repository.get(id)) throw patternError("PATTERN_NOT_FOUND", "交易模式不存在");
      return repository.addEvidence(id, normalizeEvidence(input));
    },
  });
}
