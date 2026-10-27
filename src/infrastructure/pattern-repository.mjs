function mapEvidence(row) {
  return Object.freeze({
    id: row.id, patternId: row.pattern_id, reviewId: row.review_id, sessionId: row.session_id,
    fillId: row.fill_id, startStep: row.start_step, endStep: row.end_step, note: row.note,
    realizedProfitCents: row.realized_profit_cents ?? null, createdAt: row.created_at,
  });
}

function mapPattern(row, evidence = []) {
  if (!row) return null;
  const resolved = evidence.map(mapEvidence);
  const completed = resolved.filter((item) => item.realizedProfitCents !== null);
  const successful = completed.filter((item) => item.realizedProfitCents > 0);
  return Object.freeze({
    id: row.id, name: row.name, category: row.category, displayPeriod: row.display_period,
    triggerConditions: row.trigger_conditions, klineFeatures: row.kline_features,
    indicatorFeatures: row.indicator_features, volumeFeatures: row.volume_features,
    marketContext: row.market_context, invalidationConditions: row.invalidation_conditions,
    riskNotes: row.risk_notes, confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at,
    evidence: Object.freeze(resolved),
    statistics: Object.freeze({
      evidenceCount: resolved.length,
      completedEvidenceCount: completed.length,
      successfulEvidenceCount: successful.length,
      winRateMillionths: completed.length === 0 ? null : Math.round(successful.length / completed.length * 1_000_000),
      averageRealizedProfitCents: completed.length === 0 ? null
        : Math.round(completed.reduce((sum, item) => sum + item.realizedProfitCents, 0) / completed.length),
    }),
  });
}

export function createPatternRepository(database) {
  const getRow = database.prepare("SELECT * FROM trading_patterns WHERE id = ?");
  const evidenceRows = (patternId) => database.prepare(`SELECT e.*, f.realized_profit_cents
    FROM pattern_evidence e LEFT JOIN fills f ON f.id = e.fill_id
    WHERE e.pattern_id = ? ORDER BY e.created_at, e.id`).all(patternId);
  const insertEvidence = database.prepare(`INSERT INTO pattern_evidence
    (id, pattern_id, review_id, session_id, fill_id, start_step, end_step, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  return Object.freeze({
    create(pattern, evidence) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`INSERT INTO trading_patterns(id, name, category, display_period,
          trigger_conditions, kline_features, indicator_features, volume_features, market_context,
          invalidation_conditions, risk_notes, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(pattern.id, pattern.name, pattern.category, pattern.displayPeriod, pattern.triggerConditions,
            pattern.klineFeatures, pattern.indicatorFeatures, pattern.volumeFeatures, pattern.marketContext,
            pattern.invalidationConditions, pattern.riskNotes, pattern.confidence);
        insertEvidence.run(evidence.id, pattern.id, evidence.reviewId, evidence.sessionId, evidence.fillId,
          evidence.startStep, evidence.endStep, evidence.note);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      return this.get(pattern.id);
    },
    get(id) {
      return mapPattern(getRow.get(id), evidenceRows(id));
    },
    list(category = null) {
      const rows = category
        ? database.prepare("SELECT * FROM trading_patterns WHERE category = ? ORDER BY updated_at DESC, id").all(category)
        : database.prepare("SELECT * FROM trading_patterns ORDER BY updated_at DESC, id").all();
      return Object.freeze(rows.map((row) => mapPattern(row, evidenceRows(row.id))));
    },
    update(id, values) {
      database.prepare(`UPDATE trading_patterns SET name=?, category=?, display_period=?, trigger_conditions=?,
        kline_features=?, indicator_features=?, volume_features=?, market_context=?, invalidation_conditions=?,
        risk_notes=?, confidence=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(values.name, values.category,
        values.displayPeriod, values.triggerConditions, values.klineFeatures, values.indicatorFeatures,
        values.volumeFeatures, values.marketContext, values.invalidationConditions, values.riskNotes,
        values.confidence, id);
      return this.get(id);
    },
    addEvidence(patternId, evidence) {
      insertEvidence.run(evidence.id, patternId, evidence.reviewId, evidence.sessionId, evidence.fillId,
        evidence.startStep, evidence.endStep, evidence.note);
      return this.get(patternId);
    },
  });
}
