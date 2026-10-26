import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createInsightRepository, createMatchingRepository, createTradeConfigRepository, matchOrder, openDatabase } from "./database.mjs";
import { createRandomTrainingService } from "./src/application/random-training-service.mjs";
import { advanceTrainingSession, getPublicTrainingState, rollbackTrainingSession } from "./src/domain/session/training-session.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataDirectory = join(root, "data");
mkdirSync(dataDirectory, { recursive: true });
const database = openDatabase(join(dataDirectory, "trading-trainer.sqlite"));
const marketDatabasePath = process.env.MARKET_DATABASE || join(dataDirectory, "market.db");
let marketDatabase;
try {
  marketDatabase = new DatabaseSync(marketDatabasePath);
  marketDatabase.exec("PRAGMA foreign_keys = ON");
} catch (error) {
  console.warn(`行情数据库不可用：${error.message}`);
}
const randomTraining = marketDatabase ? createRandomTrainingService({ marketDatabase }) : null;
const trainingSessions = new Map();
const insights = createInsightRepository(database);
const matching = createMatchingRepository(database);
const tradeConfig = createTradeConfigRepository(database);
const port = Number(process.env.PORT || 4173);

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
      });
      trainingSessions.set(result.session.id, result.session);
      sendJson(response, 201, { ...result.state, candidateCount: result.candidateCount });
    } catch (error) {
      sendJson(response, 422, { error: { code: error.code || "TRAINING_CREATE_FAILED", message: error.message } });
    }
    return true;
  }

  const trainingRoute = url.pathname.match(/^\/api\/random-training-sessions\/([^/]+)(?:\/(advance|rollback))?$/);
  if (trainingRoute) {
    const sessionId = decodeURIComponent(trainingRoute[1]);
    const action = trainingRoute[2];
    const session = trainingSessions.get(sessionId);
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
        const next = action === "advance"
          ? advanceTrainingSession(session, expectedVersion)
          : rollbackTrainingSession(session, expectedVersion);
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
    marketDatabase?.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
