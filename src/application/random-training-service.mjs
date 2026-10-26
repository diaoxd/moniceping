import { randomUUID } from "node:crypto";
import { selectRandomTrainingCandidate } from "../domain/session/random-candidate.mjs";
import { createTrainingSession, getPublicTrainingState } from "../domain/session/training-session.mjs";
import { loadTrainingStocks } from "../infrastructure/market-repository.mjs";

export function createRandomTrainingService({ marketDatabase, idFactory = randomUUID } = {}) {
  if (!marketDatabase) throw new Error("行情数据库不能为空");
  return {
    create({ simulationBars = 150, seed = `${Date.now()}`, initialCapitalCents = 10_000_000 } = {}) {
      const stocks = loadTrainingStocks(marketDatabase, { simulationBars });
      const selection = selectRandomTrainingCandidate({ stocks, simulationBars, seed });
      const stock = stocks.find((item) => item.stockCode === selection.candidate.stockCode);
      const session = createTrainingSession({
        id: idFactory(),
        stockCode: stock.stockCode,
        stockName: stock.stockName,
        bars: stock.bars,
        startIndex: selection.candidate.startIndex,
        simulationBars,
        initialCapitalCents,
        randomSeed: String(seed),
      });
      return {
        session,
        state: getPublicTrainingState(session),
        candidateCount: selection.candidateCount,
      };
    },
  };
}
