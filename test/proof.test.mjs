import assert from "node:assert/strict";
import test from "node:test";
import proof from "../web/public/devnet-proof.json" with { type: "json" };

const expectedLabels = [
  "Place funded matched buy order",
  "Place funded matched sell order",
  "Close matched auction at cutoff",
  "Buyer claims matched shares and quote refund",
  "Seller claims matched USDC test proceeds",
  "Place no-cross buy order",
  "Place no-cross sell order",
  "Close no-cross auction at cutoff",
  "Buyer claims full no-cross quote refund",
  "Seller claims full no-cross base refund",
];

test("proof walkthrough labels map to finalized devnet signatures", () => {
  const transactions = new Map(proof.transactions.map((item) => [item.label, item]));
  for (const label of expectedLabels) {
    const item = transactions.get(label);
    assert.ok(item, `missing proof transaction: ${label}`);
    assert.equal(item.status, "finalized");
    assert.match(item.explorerUrl, new RegExp(`/tx/${item.signature}\\?cluster=devnet$`));
  }
});
