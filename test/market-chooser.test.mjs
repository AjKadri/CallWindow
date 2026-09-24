import assert from "node:assert/strict";
import test from "node:test";
import { filterMarketProducts, quoteFormCopy, resolveMarketSelection } from "../src/market/chooser.mjs";

const products = [
  { symbol: "OPENAI", name: "OpenAI", mint: "OpenAIMint", issuerUrl: "https://prestocks.com/openai", description: "AI company" },
  { symbol: "KALSHI", name: "Kalshi", mint: "KalshiMint", issuerUrl: "https://prestocks.com/kalshi", description: "Event markets" },
];

test("market search replaces the selected product with the matching verified result", () => {
  const result = resolveMarketSelection(products, { search: "kalshi", selectedSymbol: "OPENAI" });
  assert.deepEqual(result.matches.map((product) => product.symbol), ["KALSHI"]);
  assert.equal(result.selectedSymbol, "KALSHI");
  assert.equal(result.selected.mint, "KalshiMint");
});

test("market search reports no results without retaining a stale selection", () => {
  const result = resolveMarketSelection(products, { search: "does-not-exist", selectedSymbol: "OPENAI" });
  assert.deepEqual(filterMarketProducts(products, "does-not-exist"), []);
  assert.equal(result.noResults, true);
  assert.equal(result.selected, null);
  assert.equal(result.selectedSymbol, null);
});

test("buy and sell quote labels identify the amount and optional per-token limit", () => {
  assert.deepEqual(quoteFormCopy("buy", "KALSHI"), {
    amountLabel: "Amount to spend (USDC)",
    unit: "USDC",
    limitLabel: "Maximum price per token (optional)",
    limitHelp: "This is the price for one full token, separate from the total amount spent or sold.",
  });
  assert.deepEqual(quoteFormCopy("sell", "OPENAI"), {
    amountLabel: "Amount of OPENAI to sell",
    unit: "OPENAI",
    limitLabel: "Minimum price per token (optional)",
    limitHelp: "This is the price for one full token, separate from the total amount spent or sold.",
  });
});
