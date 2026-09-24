import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATOR_ESTIMATED_FEES_LAMPORTS,
  evaluateDevnetFunding,
  readDevnetFunding,
} from "../src/wallet/funding.mjs";

function mockConnection({ account, balance, auctionRent = 2_000n, tokenRent = 500n, ownerAccounts = [null, null] }) {
  return {
    getAccountInfo: async (address) => address === "wallet" ? account : ownerAccounts.shift() ?? null,
    getBalance: async () => balance,
    getMinimumBalanceForRentExemption: async (size) => size === 2_168 ? auctionRent : tokenRent,
  };
}

async function read(overrides = {}) {
  return readDevnetFunding({
    connection: mockConnection(overrides),
    walletKey: "wallet",
    auctionAccountSize: 2_168,
    tokenAccountSize: 165,
    ownerTokenAccounts: ["base-ata", "quote-ata"],
    estimatedFeesLamports: CREATOR_ESTIMATED_FEES_LAMPORTS,
  });
}

test("opening-order funding checks only current owner rent and opening fees", async () => {
  const result = await read({ account: { lamports: 6_000 }, balance: 6_000n });
  const opening = await readDevnetFunding({
    connection: mockConnection({ account: { lamports: 6_000 }, balance: 6_000n }),
    walletKey: "wallet",
    auctionAccountSize: 2_168,
    tokenAccountSize: 165,
    ownerTokenAccounts: ["base-ata", "quote-ata"],
    phase: "opening",
  });
  assert.equal(result.phase, "create-and-opening");
  assert.equal(opening.requiredLamports, 6_000n);
  assert.equal(opening.status, "sufficient");
});

test("unfunded wallet is blocked with the full Devnet SOL shortfall", async () => {
  const result = await read({ account: null, balance: 0n });
  assert.equal(result.status, "missing");
  assert.equal(result.balanceLamports, 0n);
  assert.equal(result.requiredLamports, 14_000n);
  assert.equal(result.shortfallLamports, 14_000n);
});

test("underfunded existing wallet reports the exact shortfall", async () => {
  const result = await read({ account: { lamports: 1 }, balance: 13_999n });
  assert.equal(result.status, "insufficient");
  assert.equal(result.accountExists, true);
  assert.equal(result.requiredLamports, 14_000n);
  assert.equal(result.shortfallLamports, 1n);
});

test("sufficient wallet clears the creator funding gate", async () => {
  const result = await read({ account: { lamports: 14_000 }, balance: 14_000n });
  assert.equal(result.status, "sufficient");
  assert.equal(result.shortfallLamports, 0n);
});

test("funding evaluation keeps an existing account distinct from a missing account", () => {
  assert.equal(evaluateDevnetFunding({ accountExists: true, balanceLamports: 0n, requiredLamports: 1n }).status, "insufficient");
  assert.equal(evaluateDevnetFunding({ accountExists: false, balanceLamports: 0n, requiredLamports: 1n }).status, "missing");
});
