import assert from "node:assert/strict";
import test from "node:test";
import {
  closingWorkUpperBound,
  MAX_CANDIDATE_TICKS,
  MAX_ORDERS,
  PRICE_TICK_CENTS,
  validateAuctionBounds,
} from "../src/auction/bounds.mjs";

test("the configured maximum order and price grid are accepted", () => {
  assert.doesNotThrow(() => validateAuctionBounds({
    orderCount: MAX_ORDERS,
    candidateTickCount: MAX_CANDIDATE_TICKS,
  }));
  assert.equal(PRICE_TICK_CENTS, 1);
});

test("an order beyond the hard cap is rejected", () => {
  assert.throws(
    () => validateAuctionBounds({ orderCount: MAX_ORDERS + 1, candidateTickCount: 1 }),
    /Order limit is 32/,
  );
});

test("a candidate grid beyond the hard cap is rejected", () => {
  assert.throws(
    () => validateAuctionBounds({ orderCount: 1, candidateTickCount: MAX_CANDIDATE_TICKS + 1 }),
    /Candidate price tick limit is 101/,
  );
});

test("invalid sizes fail before any clearing work can be counted", () => {
  assert.throws(() => closingWorkUpperBound(-1, 1), /non-negative integer/);
  assert.throws(() => closingWorkUpperBound(1, 0), /positive integer/);
});

test("worst-case close work has a finite checked upper bound", () => {
  const result = closingWorkUpperBound();
  assert.equal(result.eligibilityChecks, 6_464);
  assert.equal(result.allocationSortChecks, 992);
  assert.equal(result.allocationWalkChecks, 64);
  assert.equal(result.totalComparisonUpperBound, 7_520);
});
