import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createInsightRepository, createMatchingRepository, createTradeConfigRepository, matchOrder, openDatabase } from "./database.mjs";
import { createRandomTrainingService } from "./src/application/random-training-service.mjs";
import { createReviewService } from "./src/application/review-service.mjs";
import { createPatternService } from "./src/application/pattern-service.mjs";
import { advanceTrainingSession, executeTrainingMarketOrder, finishTrainingSession, getPublicTrainingState, rollbackTrainingSession } from "./src/domain/session/training-session.mjs";
import { openAppDatabase } from "./src/infrastructure/app-database.mjs";
import { loadTrainingStock, validateMarketDatabaseSchema } from "./src/infrastructure/market-repository.mjs";
import { createTrainingSessionRepository } from "./src/infrastructure/training-session-repository.mjs";
import { createReviewRepository } from "./src/infrastructure/review-repository.mjs";
import { createPatternRepository } from "./src/infrastructure/pattern-repository.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataDirectory = join(root, "data");
mkdirSync(dataDirectory, { recursive: true });
const database = openDatabase(join(dataDirectory, "trading-trainer.sqlite"));
const appDatabase = openAppDatabase(process.env.APP_DATABASE || join(dataDirectory, "app.db"));
const sessionRepository = createTrainingSessionRepository(appDatabase);
const reviewRepository = createReviewRepository(appDatabase);
const patternRepository = createPatternRepository(appDatabase);
const marketDatabasePath = process.env.MARKET_DATABASE || join(dataDirectory, "market.db");
let marketDatabase;
try {
  marketDatabase = new DatabaseSync(marketDatabasePath);
  marketDatabase.exec("PRAGMA foreign_keys = ON");
  validateMarketDatabaseSchema(marketDatabase);
} catch (error) {
  marketDatabase?.close();
  marketDatabase = undefined;
  console.warn(`行情数据库不可用：${error.message}`);
}
const randomTraining = marketDatabase ? createRandomTrainingService({ marketDatabase }) : null;
const trainingSessions = new Map();
const insights = createInsightRepository(database);
const matching = createMatchingRepository(database);
const tradeConfig = createTradeConfigRepository(database);
const port = Number(process.env.PORT || 4173);

function findTrainingSession(sessionId) {
  const cached = trainingSessions.get(sessionId);
  if (cached) return cached;
  const metadata = appDatabase.prepare("SELECT stock_code AS stockCode FROM training_sessions WHERE id = ?").get(sessionId);
  if (!metadata || !marketDatabase) return null;
  const stock = loadTrainingStock(marketDatabase, metadata.stockCode);
  if (!stock) return null;
  const restored = sessionRepository.load(sessionId, stock.bars);
  if (restored) trainingSessions.set(sessionId, restored);
  return restored;
}

const reviewService = createReviewService({ repository: reviewRepository, loadSession: findTrainingSession });
const patternService = createPatternService({
  repository: patternRepository, reviewRepository, loadSession: findTrainingSession,
});

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": mimeTypes[".json"], "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw Object.assign(new Error("请求内容过大"), { code: "PAYLOAD_TOO_LARGE" });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("请求内容不是有效的 JSON"), { code: "INVALID_JSON" });
  }
}

function insightRoute(pathname) {
  const match = pathname.match(/^\/api\/training-sessions\/([^/]+)\/insights(?:\/([^/]+))?$/);
  if (!match) return null;
  return { sessionId: decodeURIComponent(match[1]), tradeDate: match[2] ? decodeURIComponent(match[2]) : null };
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { status: "ok", marketDatabase: Boolean(randomTraining) });
    return true;
  }

  if (url.pathname === "/api/random-training-sessions" && request.method === "POST") {
    if (!randomTraining) {
      sendJson(response, 503, { error: { code: "MARKET_DATABASE_UNAVAILABLE", message: "行情数据库不可用" } });
      return true;
    }
    try {
      const body = await readJson(request);
      const result = randomTraining.create({
        simulationBars: body.simulationBars === undefined ? 150 : Number(body.simulationBars),
        seed: body.seed === undefined ? `${Date.now()}` : String(body.seed),
        initialCapitalCents: body.initialCapitalCents === undefined ? 10_000_000 : Number(body.initialCapitalCents),
        excludeStockCode: body.excludeStockCode === undefined ? null : String(body.excludeStockCode),
      });
      sessionRepository.save(result.session);
      trainingSessions.set(result.session.id, result.session);
      sendJson(response, 201, { ...result.state, candidateCount: result.candidateCount });
    } catch (error) {
      sendJson(response, 422, { error: { code: error.code || "TRAINING_CREATE_FAILED", message: error.message } });
    }
    return true;
  }

  if (url.pathname === "/api/random-training-sessions" && request.method === "GET") {
    const rawLimit = Number(url.searchParams.get("limit") || 20);
    const rawOffset = Number(url.searchParams.get("offset") || 0);
    const status = url.searchParams.get("status") || null;
    const limit = Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
    const offset = Number.isInteger(rawOffset) ? Math.max(0, rawOffset) : 0;
    if (status && !["running", "finished"].includes(status)) {
      sendJson(response, 422, { error: { code: "INVALID_STATUS", message: "状态只能是running或finished" } });
      return true;
    }
    sendJson(response, 200, { items: sessionRepository.list({ status, limit, offset }), total: sessionRepository.count({ status }), limit, offset });
    return true;
  }

  const sessionReviewsRoute = url.pathname.match(/^\/api\/random-training-sessions\/([^/]+)\/reviews$/);
  if (sessionReviewsRoute) {
    const sessionId = decodeURIComponent(sessionReviewsRoute[1]);
    try {
      if (request.method === "GET") {
        sendJson(response, 200, { items: reviewService.list(sessionId) });
        return true;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        sendJson(response, 201, reviewService.create(sessionId, {
          selectedFillId: body.selectedFillId === undefined ? null : String(body.selectedFillId),
        }));
        return true;
      }
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
    } catch (error) {
      const status = ["TRAINING_SESSION_NOT_FOUND", "FILL_NOT_FOUND"].includes(error.code) ? 404 : 422;
      sendJson(response, status, { error: { code: error.code || "REVIEW_REQUEST_FAILED", message: error.message } });
    }
    return true;
  }

  const reviewStepRoute = url.pathname.match(/^\/api\/reviews\/([^/]+)\/steps\/(\d+)$/);
  if (reviewStepRoute) {
    const reviewId = decodeURIComponent(reviewStepRoute[1]);
    const step = Number(reviewStepRoute[2]);
    try {
      if (request.method === "GET") {
        sendJson(response, 200, reviewService.getStep(reviewId, step));
        return true;
      }
      if (request.method === "PUT") {
        const body = await readJson(request);
        sendJson(response, 200, reviewService.saveStepNote(reviewId, step, body.content));
        return true;
      }
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
    } catch (error) {
      const status = ["REVIEW_NOT_FOUND", "REVIEW_STEP_NOT_FOUND", "TRAINING_SESSION_NOT_FOUND"].includes(error.code) ? 404 : 422;
      sendJson(response, status, { error: { code: error.code || "REVIEW_REQUEST_FAILED", message: error.message } });
    }
    return true;
  }

  const reviewSummaryRoute = url.pathname.match(/^\/api\/reviews\/([^/]+)\/summary$/);
  if (reviewSummaryRoute) {
    try {
      if (request.method !== "PUT") {
        sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
        return true;
      }
      const body = await readJson(request);
      sendJson(response, 200, reviewService.saveSummary(decodeURIComponent(reviewSummaryRoute[1]), body.content));
    } catch (error) {
      sendJson(response, error.code === "REVIEW_NOT_FOUND" ? 404 : 422,
        { error: { code: error.code || "REVIEW_REQUEST_FAILED", message: error.message } });
    }
    return true;
  }

  if (url.pathname === "/api/trading-patterns") {
    try {
      if (request.method === "GET") {
        sendJson(response, 200, { items: patternService.list(url.searchParams.get("category")) });
        return true;
      }
      if (request.method === "POST") {
        sendJson(response, 201, patternService.create(await readJson(request)));
        return true;
      }
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
    } catch (error) {
      const status = ["REVIEW_NOT_FOUND", "TRAINING_SESSION_NOT_FOUND", "FILL_NOT_FOUND"].includes(error.code) ? 404 : 422;
      sendJson(response, status, { error: { code: error.code || "PATTERN_REQUEST_FAILED", message: error.message } });
    }
    return true;
  }

  const patternRoute = url.pathname.match(/^\/api\/trading-patterns\/([^/]+)(?:\/(evidence))?$/);
  if (patternRoute) {
    const patternId = decodeURIComponent(patternRoute[1]);
    try {
      if (request.method !== (patternRoute[2] ? "POST" : "PUT")) {
        sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
        return true;
      }
      const body = await readJson(request);
      sendJson(response, 200, patternRoute[2]
        ? patternService.addEvidence(patternId, body)
        : patternService.update(patternId, body));
    } catch (error) {
      const status = ["PATTERN_NOT_FOUND", "REVIEW_NOT_FOUND", "TRAINING_SESSION_NOT_FOUND", "FILL_NOT_FOUND"].includes(error.code) ? 404 : 422;
      sendJson(response, status, { error: { code: error.code || "PATTERN_REQUEST_FAILED", message: error.message } });
    }
    return true;
  }

  const equityCurveRoute = url.pathname.match(/^\/api\/random-training-sessions\/([^/]+)\/equity-curve$/);
  if (equityCurveRoute && request.method === "GET") {
    const session = findTrainingSession(decodeURIComponent(equityCurveRoute[1]));
    if (!session) {
      sendJson(response, 404, { error: { code: "TRAINING_SESSION_NOT_FOUND", message: "随机训练会话不存在" } });
      return true;
    }
    sendJson(response, 200, { items: session.snapshots.map((snapshot, sequence) => ({
      sequence, step: snapshot.advancesCompleted, equityCents: snapshot.account.equityCents,
      cashCents: snapshot.account.cashCents, positionQuantity: snapshot.position.quantity,
    })) });
    return true;
  }

  const trainingRoute = url.pathname.match(/^\/api\/random-training-sessions\/([^/]+)(?:\/(advance|rollback|finish|trade))?$/);
  const reportRoute = url.pathname.match(/^\/api\/random-training-sessions\/([^/]+)\/report$/);
  if (reportRoute && request.method === "GET") {
    const session = findTrainingSession(decodeURIComponent(reportRoute[1]));
    if (!session) {
      sendJson(response, 404, { error: { code: "TRAINING_SESSION_NOT_FOUND", message: "随机训练会话不存在" } });
      return true;
    }
    if (session.status !== "finished") {
      sendJson(response, 409, { error: { code: "SESSION_NOT_FINISHED", message: "训练尚未结束，暂不能查看结算报告" } });
      return true;
    }
    const state = getPublicTrainingState(session);
    const equityCurve = session.snapshots.map((snapshot, sequence) => ({
      sequence, step: snapshot.advancesCompleted, equityCents: snapshot.account.equityCents,
      cashCents: snapshot.account.cashCents, positionQuantity: snapshot.position.quantity,
    }));
    sendJson(response, 200, { ...state, equityCurve });
    return true;
  }
  if (trainingRoute) {
    const sessionId = decodeURIComponent(trainingRoute[1]);
    const action = trainingRoute[2];
    const session = findTrainingSession(sessionId);
    if (!session) {
      sendJson(response, 404, { error: { code: "TRAINING_SESSION_NOT_FOUND", message: "随机训练会话不存在" } });
      return true;
    }
    try {
      if (!action && request.method === "GET") {
        sendJson(response, 200, getPublicTrainingState(session));
        return true;
      }
      if (action && request.method === "POST") {
        const body = await readJson(request);
        const expectedVersion = Number(body.expectedVersion);
        let next;
        if (action === "advance") next = advanceTrainingSession(session, expectedVersion);
        else if (action === "rollback") next = rollbackTrainingSession(session, expectedVersion);
        else if (action === "finish") next = finishTrainingSession(session, expectedVersion);
        else next = executeTrainingMarketOrder(session, expectedVersion, {
          id: randomUUID(), fillId: randomUUID(), side: body.side, quantity: Number(body.quantity),
        });
        sessionRepository.save(next, expectedVersion);
        trainingSessions.set(sessionId, next);
        sendJson(response, 200, getPublicTrainingState(next));
        return true;
      }
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
    } catch (error) {
      const status = error.code === "VERSION_CONFLICT" ? 409 : 422;
      sendJson(response, status, { error: { code: error.code || "TRAINING_REQUEST_FAILED", message: error.message } });
    }
    return true;
  }

  const settingsMatch = url.pathname.match(/^\/api\/training-sessions\/([^/]+)\/matching-settings$/);
  if (settingsMatch) {
    const sessionId = decodeURIComponent(settingsMatch[1]);
    try {
      if (request.method === "GET") {
        sendJson(response, 200, matching.get(sessionId));
        return true;
      }
      if (request.method === "PUT") {
        const body = await readJson(request);
        if (typeof body.blockBuyAtLimitUp !== "boolean" || typeof body.blockSellAtLimitDown !== "boolean") {
          sendJson(response, 422, { error: { code: "INVALID_SETTINGS", message: "撮合设置必须为布尔值" } });
          return true;
        }
        sendJson(response, 200, matching.update(sessionId, body));
        return true;
      }
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
    } catch (error) {
      sendJson(response, error.code === "SESSION_NOT_FOUND" ? 404 : 400, { error: { code: error.code || "REQUEST_FAILED", message: error.message } });
    }
    return true;
  }

  const configMatch = url.pathname.match(/^\/api\/training-sessions\/([^/]+)\/trade-config$/);
  if (configMatch) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
      return true;
    }
    try {
      sendJson(response, 200, tradeConfig.get(decodeURIComponent(configMatch[1])));
    } catch (error) {
      sendJson(response, 404, { error: { code: error.code || "REQUEST_FAILED", message: error.message } });
    }
    return true;
  }

  const matchRoute = url.pathname.match(/^\/api\/training-sessions\/([^/]+)\/match$/);
  if (matchRoute) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
      return true;
    }
    const sessionId = decodeURIComponent(matchRoute[1]);
    try {
      const body = await readJson(request);
      const result = matchOrder({
        side: body.side,
        price: Number(body.price),
        previousClose: Number(body.previousClose),
        quantity: Number(body.quantity),
      }, matching.get(sessionId), tradeConfig.get(sessionId));
      sendJson(response, result.accepted ? 200 : 409, result.accepted ? result : { error: result });
    } catch (error) {
      sendJson(response, error.code === "SESSION_NOT_FOUND" ? 404 : 400, { error: { code: error.code || "REQUEST_FAILED", message: error.message } });
    }
    return true;
  }

  const route = insightRoute(url.pathname);
  if (!route) return false;
  const symbol = url.searchParams.get("symbol") || "";
  const period = url.searchParams.get("period") || "";
  if (!symbol || !period) {
    sendJson(response, 400, { error: { code: "INVALID_QUERY", message: "缺少 symbol 或 period" } });
    return true;
  }

  try {
    if (request.method === "GET" && !route.tradeDate) {
      sendJson(response, 200, { items: insights.list(route.sessionId, symbol, period) });
      return true;
    }
    if (request.method === "GET" && route.tradeDate) {
      const item = insights.get(route.sessionId, symbol, period, route.tradeDate);
      sendJson(response, item ? 200 : 404, item || { error: { code: "INSIGHT_NOT_FOUND", message: "该日暂无心得体会" } });
      return true;
    }
    if (request.method === "PUT" && route.tradeDate) {
      const body = await readJson(request);
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content || content.length > 500) {
        sendJson(response, 422, { error: { code: "INVALID_CONTENT", message: "心得体会须为 1 至 500 个字符" } });
        return true;
      }
      sendJson(response, 200, insights.save(route.sessionId, symbol, period, route.tradeDate, content));
      return true;
    }
    if (request.method === "DELETE" && route.tradeDate) {
      insights.delete(route.sessionId, symbol, period, route.tradeDate);
      response.writeHead(204);
      response.end();
      return true;
    }
    sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
  } catch (error) {
    const status = error.code === "SESSION_NOT_FOUND" ? 404 : error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
    sendJson(response, status, { error: { code: error.code || "REQUEST_FAILED", message: error.message } });
  }
  return true;
}

function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = join(root, normalize(requested));
  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "资源不存在" } });
    return;
  }
  response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (await handleApi(request, response, url)) return;
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方法" } });
    return;
  }
  serveStatic(response, url.pathname);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`交易训练助手已启动：http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    appDatabase.close();
    marketDatabase?.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
