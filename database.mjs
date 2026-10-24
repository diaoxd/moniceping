import { DatabaseSync } from "node:sqlite";

export const DEMO_SESSION_ID = "demo-session-01";

export function openDatabase(filename = "data/trading-trainer.sqlite") {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrate(database);
  seedDemoSession(database);
  return database;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS training_sessions (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS daily_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      period TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE,
      UNIQUE (session_id, symbol, period, trade_date)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_insights_session_date
      ON daily_insights(session_id, trade_date);

    CREATE TABLE IF NOT EXISTS matching_settings (
      session_id TEXT PRIMARY KEY,
      block_buy_at_limit_up INTEGER NOT NULL DEFAULT 1 CHECK(block_buy_at_limit_up IN (0, 1)),
      block_sell_at_limit_down INTEGER NOT NULL DEFAULT 1 CHECK(block_sell_at_limit_down IN (0, 1)),
      limit_rate REAL NOT NULL DEFAULT 0.10 CHECK(limit_rate > 0 AND limit_rate < 1),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS session_trade_config (
      session_id TEXT PRIMARY KEY,
      adjust_type TEXT NOT NULL DEFAULT 'pre' CHECK(adjust_type IN ('pre', 'post', 'none')),
      commission_rate REAL NOT NULL DEFAULT 0.002 CHECK(commission_rate >= 0 AND commission_rate < 1),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE
    );
  `);
}

function seedDemoSession(database) {
  database.prepare(`
    INSERT INTO training_sessions (id, symbol, period)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(DEMO_SESSION_ID, "159806", "1d");
  database.prepare(`
    INSERT INTO matching_settings (session_id)
    VALUES (?)
    ON CONFLICT(session_id) DO NOTHING
  `).run(DEMO_SESSION_ID);
  database.prepare(`
    INSERT INTO session_trade_config (session_id, adjust_type, commission_rate)
    VALUES (?, 'pre', 0.002)
    ON CONFLICT(session_id) DO UPDATE SET
      adjust_type = 'pre',
      commission_rate = 0.002,
      updated_at = CURRENT_TIMESTAMP
  `).run(DEMO_SESSION_ID);
}

export function createInsightRepository(database) {
  const sessionExists = database.prepare(`
    SELECT 1 FROM training_sessions
    WHERE id = ? AND symbol = ? AND period = ?
  `);
  const listStatement = database.prepare(`
    SELECT trade_date AS tradeDate, content, created_at AS createdAt, updated_at AS updatedAt
    FROM daily_insights
    WHERE session_id = ? AND symbol = ? AND period = ?
    ORDER BY trade_date
  `);
  const getStatement = database.prepare(`
    SELECT trade_date AS tradeDate, content, created_at AS createdAt, updated_at AS updatedAt
    FROM daily_insights
    WHERE session_id = ? AND symbol = ? AND period = ? AND trade_date = ?
  `);
  const saveStatement = database.prepare(`
    INSERT INTO daily_insights (session_id, symbol, period, trade_date, content)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, symbol, period, trade_date) DO UPDATE SET
      content = excluded.content,
      updated_at = CURRENT_TIMESTAMP
  `);
  const deleteStatement = database.prepare(`
    DELETE FROM daily_insights
    WHERE session_id = ? AND symbol = ? AND period = ? AND trade_date = ?
  `);

  function assertSession(sessionId, symbol, period) {
    if (!sessionExists.get(sessionId, symbol, period)) {
      const error = new Error("训练会话不存在或行情信息不匹配");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
  }

  return {
    list(sessionId, symbol, period) {
      assertSession(sessionId, symbol, period);
      return listStatement.all(sessionId, symbol, period);
    },
    get(sessionId, symbol, period, tradeDate) {
      assertSession(sessionId, symbol, period);
      return getStatement.get(sessionId, symbol, period, tradeDate) || null;
    },
    save(sessionId, symbol, period, tradeDate, content) {
      assertSession(sessionId, symbol, period);
      saveStatement.run(sessionId, symbol, period, tradeDate, content);
      return getStatement.get(sessionId, symbol, period, tradeDate);
    },
    delete(sessionId, symbol, period, tradeDate) {
      assertSession(sessionId, symbol, period);
      return deleteStatement.run(sessionId, symbol, period, tradeDate).changes > 0;
    },
  };
}

export function createMatchingRepository(database) {
  const getStatement = database.prepare(`
    SELECT
      block_buy_at_limit_up AS blockBuyAtLimitUp,
      block_sell_at_limit_down AS blockSellAtLimitDown,
      limit_rate AS limitRate,
      updated_at AS updatedAt
    FROM matching_settings
    WHERE session_id = ?
  `);
  const updateStatement = database.prepare(`
    UPDATE matching_settings SET
      block_buy_at_limit_up = ?,
      block_sell_at_limit_down = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE session_id = ?
  `);

  function get(sessionId) {
    const settings = getStatement.get(sessionId);
    if (!settings) {
      const error = new Error("训练会话不存在");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    return {
      ...settings,
      blockBuyAtLimitUp: Boolean(settings.blockBuyAtLimitUp),
      blockSellAtLimitDown: Boolean(settings.blockSellAtLimitDown),
    };
  }

  return {
    get,
    update(sessionId, nextSettings) {
      get(sessionId);
      updateStatement.run(
        nextSettings.blockBuyAtLimitUp ? 1 : 0,
        nextSettings.blockSellAtLimitDown ? 1 : 0,
        sessionId,
      );
      return get(sessionId);
    },
  };
}

export function createTradeConfigRepository(database) {
  const getStatement = database.prepare(`
    SELECT adjust_type AS adjustType, commission_rate AS commissionRate, updated_at AS updatedAt
    FROM session_trade_config
    WHERE session_id = ?
  `);
  return {
    get(sessionId) {
      const config = getStatement.get(sessionId);
      if (!config) {
        const error = new Error("训练会话不存在");
        error.code = "SESSION_NOT_FOUND";
        throw error;
      }
      return config;
    },
  };
}

function roundPrice(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function matchOrder({ side, price, previousClose, quantity }, settings, tradeConfig = { commissionRate: 0.002 }) {
  if (!["buy", "sell"].includes(side)) {
    return { accepted: false, code: "INVALID_SIDE", message: "交易方向无效" };
  }
  if (![price, previousClose].every((value) => Number.isFinite(value) && value > 0)) {
    return { accepted: false, code: "INVALID_PRICE", message: "成交价或昨收价无效" };
  }
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity % 100 !== 0) {
    return { accepted: false, code: "INVALID_QUANTITY", message: "交易数量必须为正数且是 100 股的整数倍" };
  }

  const limitUpPrice = roundPrice(previousClose * (1 + settings.limitRate));
  const limitDownPrice = roundPrice(previousClose * (1 - settings.limitRate));
  if (side === "buy" && settings.blockBuyAtLimitUp && price >= limitUpPrice) {
    return { accepted: false, code: "BUY_BLOCKED_AT_LIMIT_UP", message: "当前已涨停，不能买入", limitUpPrice, limitDownPrice };
  }
  if (side === "sell" && settings.blockSellAtLimitDown && price <= limitDownPrice) {
    return { accepted: false, code: "SELL_BLOCKED_AT_LIMIT_DOWN", message: "当前已跌停，不能卖出", limitUpPrice, limitDownPrice };
  }
  const grossAmount = roundPrice(price * quantity);
  const commission = roundPrice(grossAmount * tradeConfig.commissionRate);
  const cashChange = side === "buy" ? -(grossAmount + commission) : grossAmount - commission;
  return {
    accepted: true,
    code: "MATCHED",
    message: "撮合成功",
    fillPrice: price,
    quantity,
    grossAmount,
    commission,
    commissionRate: tradeConfig.commissionRate,
    cashChange,
    limitUpPrice,
    limitDownPrice,
  };
}
