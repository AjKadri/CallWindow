import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DISTRIBUTION_LIMITS,
  distributionDecision,
  getDistributorStatus,
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

test("asset distribution stops after cutoff and does not use a closed room", () => {
  const expired = distributionDecision({
    room: { ...room, cutoffTime: new Date(Date.now() - 1_000).toISOString() },
    wallet: "wallet-a",
    ledger: { claims: [] },
  });
  assert.equal(expired.status, "unavailable");
  assert.equal(distributionDecision({ room: null, wallet: "wallet-a", ledger: { claims: [] } }).status, "unavailable");
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
