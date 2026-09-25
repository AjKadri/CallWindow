import assert from "node:assert/strict";
import test from "node:test";
import {
  cutoffSecondsFromMinutes,
  creatorOpeningOrderState,
  expectedLocalCloseLabel,
  openingWindowStatus,
} from "../src/auction/creator.mjs";

test("creator cutoff uses a 15-minute default window and preserves the one-hour bound", () => {
  assert.equal(cutoffSecondsFromMinutes(15), 900);
  assert.equal(cutoffSecondsFromMinutes(1), 60);
  assert.equal(cutoffSecondsFromMinutes(60), 3_600);
  assert.throws(() => cutoffSecondsFromMinutes(0), /between 1 and 60 minutes/);
  assert.throws(() => cutoffSecondsFromMinutes(61), /between 1 and 60 minutes/);
  assert.match(expectedLocalCloseLabel(15, Date.UTC(2026, 0, 1, 12, 0), "UTC"), /12:15/);
});

test("closed and expired creator setups cannot accept an opening order", () => {
  const closed = openingWindowStatus({ state: 1, cutoffTime: 2_000n, chainTime: 1_000n });
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, "state");
  assert.match(closed.message, /closed/);

  const expired = openingWindowStatus({ state: 0, cutoffTime: 1_000n, chainTime: 1_000n });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");
  assert.match(expired.message, /cutoff has passed/);
});

test("creator state check stays unavailable when Devnet time or cutoff cannot be read", () => {
  const unavailable = openingWindowStatus({ state: 0, cutoffTime: null, chainTime: 1_000n });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, "unavailable");
});

test("creator opening action ignores the unrelated closed operator room", () => {
  const resumed = creatorOpeningOrderState({
    walletConnected: true,
    walletAddress: "creator-wallet",
    creatorAddress: "creator-wallet",
    setupAuctionAddress: "creator-auction",
    loadedAuctionAddress: "operator-auction",
    auctionState: 1,
    cutoffTime: 1_000n,
    nowSeconds: 2_000,
  });
  assert.deepEqual(resumed, { disabled: false, reason: "ready" });

  const expired = creatorOpeningOrderState({
    walletConnected: true,
    walletAddress: "creator-wallet",
    creatorAddress: "creator-wallet",
    setupAuctionAddress: "creator-auction",
    loadedAuctionAddress: "creator-auction",
    auctionState: 0,
    cutoffTime: 1_000n,
    nowSeconds: 2_000,
  });
  assert.deepEqual(expired, { disabled: true, reason: "closed" });

  const savedExpired = creatorOpeningOrderState({
    walletConnected: true,
    walletAddress: "creator-wallet",
    creatorAddress: "creator-wallet",
    setupAuctionAddress: "creator-auction",
    loadedAuctionAddress: "operator-auction",
    auctionState: 1,
    cutoffTime: 1_000n,
    savedCutoffTime: 1_000n,
    nowSeconds: 2_000,
  });
  assert.deepEqual(savedExpired, { disabled: true, reason: "closed" });
});
