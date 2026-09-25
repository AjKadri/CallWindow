import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DISTRIBUTION_LIMITS,
  DISTRIBUTION_LEDGER_VERSION,
  broadcastDistributionAttempt,
  classifyDistributorFundingError,
  distributionDecision,
  getMarketDistributorStatus,
  getSharedDistributorStatus,
  getDistributorStatus,
  globalDistributionDecision,
  normalizeClaims,
  normalizeAttempts,
  reconcileDistributionAttempt,
  retryDevnetRead,
  validateMarketAuctionRecord,
  validateSharedAuctionRecord,
  validateLiveAuctionRoom,
  verifyDevnetRpc,
  withDistributionLock,
} from "../src/server/auction-room.mjs";

const room = {
  status: "open",
  network: "devnet",
  programId: "GxX6X6zZSQSuxEoTHPwaAmKCcpGRVRiB6ERANHzS7Eq9",
  auctionAddress: "2P7zsEgyyVwjyxZPydrXekZBPUWt2KcxqkbwnJti6ZfW",
  cutoffTime: new Date(Date.now() + 60_000).toISOString(),
  mints: {
    base: { name: "DEMO-EQUITY", address: "B6ZoEr92PB58bN1MgTXwjZHBUxCZ895ERVdhFJtSQFcP", decimals: 2 },
    quote: { name: "DEMO-USD", address: "7gLQ8vdtYTxbHa4YK9gjjsVe49WiKeH6pi2pV8us8zd4", decimals: 6 },
  },
};

test("live room accepts only the open devnet test-asset configuration", () => {
  assert.equal(validateLiveAuctionRoom(room), true);
  assert.equal(validateLiveAuctionRoom({ ...room, network: "mainnet-beta" }), false);
  assert.equal(validateLiveAuctionRoom({ ...room, status: "closed" }), false);
  assert.equal(validateLiveAuctionRoom({
    ...room,
    mints: { ...room.mints, base: { ...room.mints.base, address: "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua" } },
  }), false);
});

test("asset distribution allows two claims per wallet and caps the global ledger", () => {
  assert.equal(DISTRIBUTION_LIMITS.maxClaimsPerWallet, 2);
  assert.equal(DISTRIBUTION_LIMITS.maxClaimsTotal, 50);
  assert.equal(DISTRIBUTION_LEDGER_VERSION, 3);
  const first = distributionDecision({ room, wallet: "wallet-a", ledger: { claims: [] } });
  assert.equal(first.allowed, true);
  const second = distributionDecision({ room, wallet: "wallet-a", ledger: { claims: [{ wallet: "wallet-a" }] } });
  assert.equal(second.allowed, true);
  const repeated = distributionDecision({ room, wallet: "wallet-a", ledger: { claims: [{ wallet: "wallet-a" }, { wallet: "wallet-a" }] } });
  assert.equal(repeated.status, "limited");
  assert.match(repeated.reason, /2-claim/);
  const full = distributionDecision({
    room,
    wallet: "wallet-new",
    ledger: { claims: Array.from({ length: DISTRIBUTION_LIMITS.maxClaimsTotal }, (_, index) => ({ wallet: "wallet-" + index })) },
  });
  assert.equal(full.status, "limited");
});

test("distribution reset ignores the pre-reset claim ledger version", () => {
  const decision = globalDistributionDecision({
    wallet: "wallet-a",
    ledger: { version: 1, claims: [{ wallet: "wallet-a" }, { wallet: "wallet-a" }] },
  });
  assert.equal(decision.allowed, true);
});

test("global distribution keeps the two-claim wallet limit across shared windows", () => {
  const first = globalDistributionDecision({ wallet: "wallet-a", ledger: { claims: [] } });
  assert.equal(first.allowed, true);
  const second = globalDistributionDecision({
    wallet: "wallet-a",
    ledger: { claims: [{ wallet: "wallet-a", auctionAddress: "first-auction" }] },
  });
  assert.equal(second.allowed, true);
  const repeated = globalDistributionDecision({
    wallet: "wallet-a",
    ledger: { claims: [{ wallet: "wallet-a", auctionAddress: "first-auction" }, { wallet: "wallet-a", auctionAddress: "second-auction" }] },
  });
  assert.equal(repeated.status, "limited");
  assert.match(repeated.reason, /2-claim/);
  const legacy = normalizeClaims({
    auctionAddress: "legacy-auction",
    claims: [{ wallet: "wallet-b" }],
  });
  assert.equal(legacy[0].auctionAddress, "legacy-auction");
  const full = globalDistributionDecision({
    wallet: "wallet-new",
    ledger: { claims: Array.from({ length: DISTRIBUTION_LIMITS.maxClaimsTotal }, (_, index) => ({ wallet: "wallet-" + index })) },
  });
  assert.equal(full.status, "limited");
  assert.match(full.reason, /global/);
});

test("durable unresolved attempts occupy wallet and global claim slots", () => {
  const attempt = {
    wallet: "wallet-a",
    signature: "signed-attempt",
    status: "broadcasted",
  };
  assert.equal(normalizeAttempts({ version: DISTRIBUTION_LEDGER_VERSION, attempts: [attempt] }).length, 1);
  const walletLimited = globalDistributionDecision({
    wallet: "wallet-a",
    ledger: { version: DISTRIBUTION_LEDGER_VERSION, claims: [{ wallet: "wallet-a" }], attempts: [attempt] },
  });
  assert.equal(walletLimited.status, "limited");
  const globallyLimited = globalDistributionDecision({
    wallet: "wallet-new",
    ledger: {
      version: DISTRIBUTION_LEDGER_VERSION,
      claims: Array.from({ length: DISTRIBUTION_LIMITS.maxClaimsTotal - 1 }, (_, index) => ({ wallet: "wallet-" + index })),
      attempts: [{ ...attempt, wallet: "wallet-last" }],
    },
  });
  assert.equal(globallyLimited.status, "limited");
});

test("Devnet RPC verification rejects a non-Devnet genesis hash before mint send", async () => {
  await assert.doesNotReject(() => verifyDevnetRpc({ getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }));
  await assert.rejects(
    () => verifyDevnetRpc({ getGenesisHash: async () => "mainnet-genesis" }),
    /not Devnet/,
  );
});

test("confirmation timeout leaves the signed attempt available for reconciliation", async () => {
  let sends = 0;
  await assert.rejects(
    () => broadcastDistributionAttempt({
      sendRawTransaction: async () => { sends += 1; return "signed-attempt"; },
      confirmTransaction: async () => { throw new Error("confirmation timeout"); },
    }, {
      signature: "signed-attempt",
      serializedTransaction: Buffer.from("signed-bytes").toString("base64"),
      blockhash: "fresh-blockhash",
      lastValidBlockHeight: 123,
    }),
    /confirmation timeout/,
  );
  assert.equal(sends, 1);
});

test("a 429 after broadcast does not create a second signed identity", async () => {
  let sends = 0;
  await assert.rejects(
    () => broadcastDistributionAttempt({
      sendRawTransaction: async () => { sends += 1; return "signed-attempt"; },
      confirmTransaction: async () => { throw Object.assign(new Error("429 after broadcast"), { status: 429 }); },
    }, {
      signature: "signed-attempt",
      serializedTransaction: Buffer.from("signed-bytes").toString("base64"),
      blockhash: "fresh-blockhash",
      lastValidBlockHeight: 123,
    }),
    /429 after broadcast/,
  );
  assert.equal(sends, 1);
});

test("reconciliation recognizes a finalized prior attempt without signing", async () => {
  const result = await reconcileDistributionAttempt({
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "finalized", err: null }] }),
  }, {
    signature: "signed-attempt",
    serializedTransaction: Buffer.from("signed-bytes").toString("base64"),
    lastValidBlockHeight: 123,
  });
  assert.deepEqual(result, { status: "finalized" });
});

test("a crash before ledger completion can resend the same signed bytes while the blockhash is valid", async () => {
  let resentBytes;
  const result = await reconcileDistributionAttempt({
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 122,
    sendRawTransaction: async (bytes) => { resentBytes = bytes; return "signed-attempt"; },
  }, {
    signature: "signed-attempt",
    serializedTransaction: Buffer.from("signed-bytes").toString("base64"),
    lastValidBlockHeight: 123,
  });
  assert.deepEqual(result, { status: "pending" });
  assert.equal(Buffer.from(resentBytes).toString(), "signed-bytes");
});

test("the shared distributor lock rejects a concurrent process instead of overspending the last slot", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "callwindow-distribution-lock-"));
  const lockPath = path.join(directory, "claims.lock");
  let release;
  const held = withDistributionLock(() => new Promise((resolve) => { release = resolve; }), { lockPath, maxWaitMs: 500, pollMs: 5 });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    () => withDistributionLock(() => Promise.resolve(), { lockPath, maxWaitMs: 20, pollMs: 5 }),
    /locked/,
  );
  release();
  await held;
});

test("shared distribution accepts only an open exact-mint bounded devnet record", () => {
  const valid = validateSharedAuctionRecord({
    baseMint: room.mints.base.address,
    quoteMint: room.mints.quote.address,
    firstTickCents: 1950,
    candidateTickCount: 101,
    openingReferenceCents: 2000,
    orderCount: 2,
    orderStorageLength: 32,
    state: 0,
    cutoffTime: BigInt(Math.floor(Date.now() / 1000) + 60),
  }, { accountOwner: room.programId });
  assert.equal(valid.ok, true);
  assert.equal(validateSharedAuctionRecord({
    baseMint: "wrong",
    quoteMint: room.mints.quote.address,
    firstTickCents: 1950,
    candidateTickCount: 101,
    openingReferenceCents: 2000,
    orderCount: 2,
    orderStorageLength: 32,
    state: 0,
    cutoffTime: BigInt(Math.floor(Date.now() / 1000) + 60),
  }, { accountOwner: room.programId }).ok, false);
  assert.equal(validateSharedAuctionRecord({
    baseMint: room.mints.base.address,
    quoteMint: room.mints.quote.address,
    firstTickCents: 1950,
    candidateTickCount: 101,
    openingReferenceCents: 2000,
    orderCount: 2,
    orderStorageLength: 32,
    state: 1,
    cutoffTime: BigInt(Math.floor(Date.now() / 1000) + 60),
  }, { accountOwner: room.programId }).ok, false);
});

test("market auction validation keeps each product on its own server allowlisted test mint", () => {
  const marketConfig = {
    symbol: "KALSHI",
    testMint: "J9JEhzraKShKaY6o6Lidi3RKYTRD2G6USV7L5BXuSm5n",
    testName: "CW-KALSHI-TEST",
    quoteMint: room.mints.quote.address,
  };
  const record = {
    baseMint: marketConfig.testMint,
    quoteMint: marketConfig.quoteMint,
    firstTickCents: 1950,
    candidateTickCount: 101,
    openingReferenceCents: 2000,
    orderCount: 2,
    orderStorageLength: 32,
    state: 0,
    cutoffTime: BigInt(Math.floor(Date.now() / 1000) + 60),
  };
  assert.equal(validateMarketAuctionRecord(record, { accountOwner: room.programId, marketConfig }).ok, true);
  assert.equal(validateMarketAuctionRecord({ ...record, baseMint: room.mints.base.address }, { accountOwner: room.programId, marketConfig }).ok, false);
  assert.equal(validateMarketAuctionRecord({ ...record, state: 1 }, { accountOwner: room.programId, marketConfig, requireOpen: false }).ok, true);
  assert.equal(validateMarketAuctionRecord({ ...record, state: 1 }, { accountOwner: room.programId, marketConfig }).ok, false);
});

test("asset distribution stops after cutoff and does not use a closed room", () => {
  const expired = distributionDecision({
    room: { ...room, cutoffTime: new Date(Date.now() - 1_000).toISOString() },
    wallet: "wallet-a",
    ledger: { claims: [] },
  });
  assert.equal(expired.status, "unavailable");
  assert.equal(distributionDecision({ room: null, wallet: "wallet-a", ledger: { claims: [] } }).status, "unavailable");
});

test("market asset distribution can prepare a wallet without an open auction", () => {
  const first = distributionDecision({
    market: { symbol: "SPACEX", testMint: "HwjCQ5qQRGfQsknMRKT8Uc6iLU7XwzuNK9NSMtLmmUqc" },
    wallet: "wallet-new",
    ledger: { claims: [] },
  });
  assert.equal(first.allowed, true);
  const repeated = distributionDecision({
    market: { symbol: "SPACEX" },
    wallet: "wallet-new",
    ledger: { claims: [{ wallet: "wallet-new" }, { wallet: "wallet-new" }] },
  });
  assert.equal(repeated.status, "limited");
  assert.match(repeated.reason, /2-claim/);
});

test("distributor distinguishes Devnet RPC rate limits from missing mint configuration", () => {
  assert.match(classifyDistributorFundingError(new Error("429 Too Many Requests")), /rate-limited/);
  assert.match(classifyDistributorFundingError(new Error("429 Too Many Requests")), /No test-asset transaction was sent/);
  assert.match(classifyDistributorFundingError(new Error("TokenInvalidAccountData")), /test mints are currently unavailable/);
});

test("distributor retries a bounded Devnet RPC rate limit before giving up", async () => {
  let attempts = 0;
  const result = await retryDevnetRead(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("Connection rate limits exceeded"), { status: 429 });
    return "ok";
  }, { delayMs: 0 });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("market distributor tells an already-claimed wallet why it cannot claim again", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "callwindow-market-distributor-"));
  const keyPath = path.join(directory, "authority.json");
  const ledgerPath = path.join(directory, "claims.json");
  await writeFile(keyPath, "[]");
  await writeFile(ledgerPath, JSON.stringify({ claims: [{ wallet: "wallet-a" }, { wallet: "wallet-a" }] }));
  const status = await getMarketDistributorStatus("SPACEX", {
    wallet: "wallet-a",
    keyPath,
    ledgerPath,
    marketFetchImpl: async () => new Response(JSON.stringify([{
      name: "SpaceX PreStocks",
      symbol: "SPACEX",
      contract_address: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh",
      external_url: "https://prestocks.com/spacex",
    }]), { headers: { "content-type": "application/json" } }),
  });
  assert.equal(status.status, "limited");
  assert.match(status.reason, /2-claim/);
});

test("distributor status exposes an exhausted cap instead of a usable CTA", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "callwindow-distributor-"));
  const keyPath = path.join(directory, "authority.json");
  const ledgerPath = path.join(directory, "claims.json");
  await writeFile(keyPath, "[]");
  await writeFile(ledgerPath, JSON.stringify({
    auctionAddress: room.auctionAddress,
    claims: Array.from({ length: DISTRIBUTION_LIMITS.maxClaimsTotal }, (_, index) => ({ wallet: "wallet-" + index })),
  }));
  const status = await getDistributorStatus(room, keyPath, Date.now(), ledgerPath);
  assert.equal(status.status, "unavailable");
  assert.equal(status.remainingClaims, 0);
  assert.match(status.reason, /cap/);
});

test("shared distributor reports missing server funding configuration explicitly", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "callwindow-shared-distributor-"));
  const status = await getSharedDistributorStatus(room.auctionAddress, {
    keyPath: path.join(directory, "missing-authority.json"),
  });
  assert.equal(status.status, "unavailable");
  assert.match(status.reason, /not configured/);
});
