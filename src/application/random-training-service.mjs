import { randomUUID } from "node:crypto";
import { selectRandomTrainingRange } from "../domain/session/random-candidate.mjs";
import { createTrainingSession, getPublicTrainingState } from "../domain/session/training-session.mjs";
import { loadTrainingRanges, loadTrainingStock } from "../infrastructure/market-repository.mjs";

export function createRandomTrainingService({ marketDatabase, idFactory = randomUUID } = {}) {
  if (!marketDatabase) throw new Error("行情数据库不能为空");
  const rangesBySimulationBars = new Map();
  return {
    create({ simulationBars = 150, seed = `${Date.now()}`, initialCapitalCents = 10_000_000 } = {}) {
      let ranges = rangesBySimulationBars.get(simulationBars);
      if (!ranges) {
        ranges = loadTrainingRanges(marketDatabase, { simulationBars });
        rangesBySimulationBars.set(simulationBars, ranges);
      }
      const selection = selectRandomTrainingRange({ ranges, simulationBars, seed });
      const stock = loadTrainingStock(marketDatabase, selection.candidate.stockCode);
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
