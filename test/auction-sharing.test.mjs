import assert from "node:assert/strict";
import test from "node:test";
import {
  DEMO_BASE_MINT,
  DEMO_QUOTE_MINT,
  DEVNET_PROGRAM_ID,
  canShareSetup,
  creatorWindowState,
  orderRequirements,
  previewAuction,
  sharedRoomUrl,
  validateSharedAuction,
} from "../src/auction/room.mjs";

function auction(overrides = {}) {
  return {
    baseMint: DEMO_BASE_MINT,
    quoteMint: DEMO_QUOTE_MINT,
    firstTickCents: 1950,
    candidateTickCount: 101,
    openingReferenceCents: 2000,
    orderCount: 2,
    state: 0,
    orders: [
      { side: 0, status: 0, limitPriceCents: 2000, quantityBaseUnits: 150n },
      { side: 1, status: 0, limitPriceCents: 2000, quantityBaseUnits: 100n },
    ],
    ...overrides,
  };
}

test("shared auction validation requires program ownership, exact mints, and deployed bounds", () => {
  assert.equal(validateSharedAuction(auction(), { accountOwner: DEVNET_PROGRAM_ID }).ok, true);
  assert.equal(validateSharedAuction(auction(), { accountOwner: "11111111111111111111111111111111" }).ok, false);
  assert.equal(validateSharedAuction({ ...auction(), baseMint: "wrong" }, { accountOwner: DEVNET_PROGRAM_ID }).ok, false);
  assert.equal(validateSharedAuction(auction({ candidateTickCount: 102 }), { accountOwner: DEVNET_PROGRAM_ID }).ok, false);
  assert.equal(validateSharedAuction(auction({ orderCount: 33 }), { accountOwner: DEVNET_PROGRAM_ID }).ok, false);
});

test("preview mirrors clearing priority and excludes cancelled orders", () => {
  const preview = previewAuction(auction());
  assert.equal(preview.priceCents, 2000);
  assert.equal(preview.matchedBase, 100n);
  assert.equal(preview.remainingImbalance, 50n);
  assert.equal(preview.fundedBuyBase, 150n);
  assert.equal(preview.fundedSellBase, 100n);
  const cancelled = previewAuction(auction({
    orders: auction().orders.map((order, index) => index === 1 ? { ...order, status: 1 } : order),
  }));
  assert.equal(cancelled.matchedBase, 0n);
  assert.equal(cancelled.fundedSellBase, 0n);
});

test("preview prefers the candidate closest to the opening reference after match and imbalance", () => {
  const result = previewAuction(auction({
    openingReferenceCents: 2001,
    orders: [
      { side: 0, status: 0, limitPriceCents: 2001, quantityBaseUnits: 100n },
      { side: 1, status: 0, limitPriceCents: 1999, quantityBaseUnits: 100n },
    ],
  }));
  assert.equal(result.priceCents, 2001);
});

test("creator sharing is gated on both finalized signatures", () => {
  assert.equal(canShareSetup({ createSignature: "create" }), false);
  assert.equal(canShareSetup({ openingSignature: "open" }), false);
  assert.equal(canShareSetup({ createSignature: "create", openingSignature: "open" }), true);
});

test("creator form changes from connect to create and preserves existing setup state", () => {
  const initial = creatorWindowState({ walletKey: false });
  assert.equal(initial.buttonText, "Connect wallet to create window");
  assert.equal(initial.buttonDisabled, true);
  assert.match(initial.status, /Connect a devnet wallet/);
  const connected = creatorWindowState({ walletKey: true });
  assert.equal(connected.buttonText, "Create window account");
  assert.equal(connected.buttonDisabled, false);
  assert.match(connected.status, /Connected on devnet/);
  const existing = creatorWindowState({ walletKey: true, setup: { createSignature: "create" } });
  assert.equal(existing.buttonText, "Window account created");
  assert.equal(existing.buttonDisabled, true);
  assert.match(existing.status, /Finish the opening order/);
  const ready = creatorWindowState({ walletKey: true, setup: { createSignature: "create", openingSignature: "open" } });
  assert.equal(ready.buttonText, "Opening order finalized");
  assert.match(ready.status, /can be shared/);
});

test("order requirements use deployed mint decimals", () => {
  assert.deepEqual(orderRequirements({ side: 0, quantityBaseUnits: 150n, limitPriceCents: 2000 }), {
    baseUnits: 0n,
    quoteUnits: 30_000_000n,
  });
  assert.deepEqual(orderRequirements({ side: 1, quantityBaseUnits: 150n, limitPriceCents: 2000 }), {
    baseUnits: 150n,
    quoteUnits: 0n,
  });
});

test("shared room URL carries only the auction address", () => {
  const url = sharedRoomUrl("https://callwindow.example", "9dump5WWF65eMNVt3QNsgcjfku5He9jLwzhUf1Ndp6Gj");
  assert.equal(url, "https://callwindow.example/room/?auction=9dump5WWF65eMNVt3QNsgcjfku5He9jLwzhUf1Ndp6Gj");
});
