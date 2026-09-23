import { performance } from "node:perf_hooks";
import { closingWorkUpperBound, MAX_CANDIDATE_TICKS, MAX_ORDERS } from "../src/auction/bounds.mjs";

const orders = Array.from({ length: MAX_ORDERS }, (_, index) => ({
  side: index % 2 === 0 ? "buy" : "sell",
  limitCents: 100 + (index % MAX_CANDIDATE_TICKS),
  quantity: 1 + index,
}));
const ticks = Array.from({ length: MAX_CANDIDATE_TICKS }, (_, index) => 100 + index);
const upperBound = closingWorkUpperBound();

let observedChecks = 0;
const start = performance.now();
for (let pass = 0; pass < 100_000; pass += 1) {
  let score = 0;
  for (const tick of ticks) {
    let buy = 0;
    let sell = 0;
    for (const order of orders) {
      observedChecks += 2;
      if (order.side === "buy" && order.limitCents >= tick) buy += order.quantity;
      if (order.side === "sell" && order.limitCents <= tick) sell += order.quantity;
    }
    score += Math.min(buy, sell);
  }
  if (score < 0) throw new Error("Unreachable benchmark guard");
}
const elapsedMs = performance.now() - start;

console.log(JSON.stringify({
  measurement: "bounded candidate scan preflight; Node CPU only, not Solana compute units",
  maxOrders: MAX_ORDERS,
  maxCandidateTicks: MAX_CANDIDATE_TICKS,
  tickSizeCents: 1,
  measuredPasses: 100_000,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  observedEligibilityChecks: observedChecks,
  maxCloseComparisonUpperBound: upperBound.totalComparisonUpperBound,
  comparisonBreakdown: upperBound,
}, null, 2));
