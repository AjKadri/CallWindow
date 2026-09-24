import assert from "node:assert/strict";
import test from "node:test";
import { evaluateQuoteLimit, MAX_QUOTE_AGE_SECONDS } from "../src/quote/limit.mjs";

const now = Date.parse("2026-09-24T12:00:00.000Z");
const quote = {
  status: "available",
  observedAt: new Date(now).toISOString(),
  effectivePriceUsdPerToken: 100,
};

test("buy limits meet at equality and fail above the effective price", () => {
  assert.equal(evaluateQuoteLimit({ quote, side: "buy", limit: "100", now }).meets, true);
  assert.equal(evaluateQuoteLimit({ quote, side: "buy", limit: "99.99", now }).meets, false);
});

test("sell limits meet at equality and fail below the effective price", () => {
  assert.equal(evaluateQuoteLimit({ quote, side: "sell", limit: "100", now }).meets, true);
  assert.equal(evaluateQuoteLimit({ quote, side: "sell", limit: "100.01", now }).meets, false);
});

test("invalid limits make no determination", () => {
  for (const limit of ["", "0", "-1", "not-a-number"]) {
    assert.equal(evaluateQuoteLimit({ quote, side: "buy", limit, now }).status, "invalid");
  }
});

test("stale and unavailable quotes make no determination", () => {
  const stale = { ...quote, observedAt: new Date(now - (MAX_QUOTE_AGE_SECONDS + 1) * 1000).toISOString() };
  assert.equal(evaluateQuoteLimit({ quote: stale, side: "buy", limit: "100", now }).reason, "quote-stale");
  assert.equal(evaluateQuoteLimit({ quote: { status: "unavailable" }, side: "buy", limit: "100", now }).reason, "quote-unavailable");
});

test("a malformed effective price makes no determination", () => {
  assert.equal(evaluateQuoteLimit({ quote: { ...quote, effectivePriceUsdPerToken: null }, side: "buy", limit: "100", now }).reason, "price-unavailable");
});
