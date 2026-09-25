import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DISTRIBUTION_LIMITS,
  classifyDistributorFundingError,
  distributionDecision,
  getMarketDistributorStatus,
  getSharedDistributorStatus,
  getDistributorStatus,
  globalDistributionDecision,
  normalizeClaims,
  validateMarketAuctionRecord,
  validateSharedAuctionRecord,
  validateLiveAuctionRoom,
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

test("asset distribution permits one claim per wallet and caps the room", () => {
  const first = distributionDecision({ room, wallet: "wallet-a", ledger: { claims: [] } });
  assert.equal(first.allowed, true);
  const repeated = distributionDecision({ room, wallet: "wallet-a", ledger: { claims: [{ wallet: "wallet-a" }] } });
  assert.equal(repeated.status, "limited");
  const full = distributionDecision({
    room,
    wallet: "wallet-new",
    ledger: { claims: Array.from({ length: DISTRIBUTION_LIMITS.maxClaimsTotal }, (_, index) => ({ wallet: "wallet-" + index })) },
  });
  assert.equal(full.status, "limited");
});

test("global distribution keeps one wallet claim across shared windows", () => {
  const first = globalDistributionDecision({ wallet: "wallet-a", ledger: { claims: [] } });
  assert.equal(first.allowed, true);
  const repeated = globalDistributionDecision({
    wallet: "wallet-a",
    ledger: { claims: [{ wallet: "wallet-a", auctionAddress: "first-auction" }] },
  });
  assert.equal(repeated.status, "limited");
  assert.match(repeated.reason, /already claimed/);
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
    ledger: { claims: [{ wallet: "wallet-new" }] },
  });
  assert.equal(repeated.status, "limited");
  assert.match(repeated.reason, /already claimed/);
});

test("distributor distinguishes Devnet RPC rate limits from missing mint configuration", () => {
  assert.match(classifyDistributorFundingError(new Error("429 Too Many Requests")), /rate-limited/);
  assert.match(classifyDistributorFundingError(new Error("TokenInvalidAccountData")), /test mints are currently unavailable/);
});

test("market distributor tells an already-claimed wallet why it cannot claim again", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "callwindow-market-distributor-"));
  const keyPath = path.join(directory, "authority.json");
  const ledgerPath = path.join(directory, "claims.json");
  await writeFile(keyPath, "[]");
  await writeFile(ledgerPath, JSON.stringify({ claims: [{ wallet: "wallet-a" }] }));
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
  assert.match(status.reason, /already claimed/);
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
