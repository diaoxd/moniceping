function mapReview(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    sessionId: row.session_id,
    selectedFillId: row.selected_fill_id,
    startStep: row.start_step,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createReviewRepository(database) {
  const getReview = database.prepare("SELECT * FROM training_reviews WHERE id = ?");
  return Object.freeze({
    create({ id, sessionId, selectedFillId = null, startStep }) {
      database.prepare(`INSERT INTO training_reviews(id, session_id, selected_fill_id, start_step)
        VALUES (?, ?, ?, ?)`).run(id, sessionId, selectedFillId, startStep);
      return mapReview(getReview.get(id));
    },
    get(id) {
      return mapReview(getReview.get(id));
    },
    listBySession(sessionId) {
      return Object.freeze(database.prepare(`SELECT * FROM training_reviews
        WHERE session_id = ? ORDER BY created_at DESC, id`).all(sessionId).map(mapReview));
    },
    getStepNote(reviewId, step) {
      return database.prepare(`SELECT content, updated_at AS updatedAt FROM review_step_notes
        WHERE review_id = ? AND step = ?`).get(reviewId, step) || null;
    },
    saveStepNote(reviewId, step, content) {
      database.prepare(`INSERT INTO review_step_notes(review_id, step, content)
        VALUES (?, ?, ?) ON CONFLICT(review_id, step) DO UPDATE SET
        content=excluded.content, updated_at=CURRENT_TIMESTAMP`).run(reviewId, step, content);
      return this.getStepNote(reviewId, step);
    },
    saveSummary(reviewId, summary) {
      database.prepare(`UPDATE training_reviews SET summary = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(summary, reviewId);
      return mapReview(getReview.get(reviewId));
    },
  });
}
