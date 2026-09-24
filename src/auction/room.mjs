export const DEVNET_PROGRAM_ID = "GxX6X6zZSQSuxEoTHPwaAmKCcpGRVRiB6ERANHzS7Eq9";
export const DEMO_BASE_MINT = "B6ZoEr92PB58bN1MgTXwjZHBUxCZ895ERVdhFJtSQFcP";
export const DEMO_QUOTE_MINT = "7gLQ8vdtYTxbHa4YK9gjjsVe49WiKeH6pi2pV8us8zd4";
export const MAX_ORDERS = 32;
export const MAX_CANDIDATE_TICKS = 101;
export const MIN_CANDIDATE_TICKS = 1;
export const MAX_PRICE_CENTS = 10_000;
export const MAX_ORDER_BASE_UNITS = 10_000n;
export const ORDER_ACTIVE = 0;
export const ORDER_CANCELLED = 1;

function absolute(value) {
  return value < 0 ? -value : value;
}

function candidateIsBetter(next, current) {
  if (!current) return true;
  if (next.matchedBase !== current.matchedBase) return next.matchedBase > current.matchedBase;
  if (next.imbalance !== current.imbalance) return next.imbalance < current.imbalance;
  if (next.distance !== current.distance) return next.distance < current.distance;
  return next.priceCents < current.priceCents;
}

export function validateSharedAuction(
  auction,
  { accountOwner, programId = DEVNET_PROGRAM_ID } = {},
) {
  const errors = [];
  if (accountOwner !== programId) errors.push("The account is not owned by the CallWindow devnet program.");
  if (auction?.baseMint !== DEMO_BASE_MINT || auction?.quoteMint !== DEMO_QUOTE_MINT) {
    errors.push("The auction does not use the exact DEMO-EQUITY and DEMO-USD devnet mints.");
  }
  if (!auction || !Number.isInteger(auction.firstTickCents) || !Number.isInteger(auction.candidateTickCount)) {
    errors.push("The auction grid is unavailable.");
  } else {
    const lastTick = auction.firstTickCents + auction.candidateTickCount - 1;
    if (auction.candidateTickCount < MIN_CANDIDATE_TICKS || auction.candidateTickCount > MAX_CANDIDATE_TICKS) {
      errors.push("The auction exceeds the 101-tick program bound.");
    }
    if (auction.firstTickCents < 1 || lastTick > MAX_PRICE_CENTS) {
      errors.push("The auction price grid is outside the deployed program bounds.");
    }
    if (auction.openingReferenceCents < auction.firstTickCents || auction.openingReferenceCents > lastTick) {
      errors.push("The opening reference is outside the auction grid.");
    }
  }
  if (!Number.isInteger(auction?.orderCount) || auction.orderCount < 0 || auction.orderCount > MAX_ORDERS) {
    errors.push("The auction exceeds the 32-order program bound.");
  }
  if (Array.isArray(auction?.orders) && auction.orders.length !== auction.orderCount) {
    errors.push("The decoded order count does not match the account.");
  }
  if (!Number.isInteger(auction?.state) || auction.state < 0 || auction.state > 3) {
    errors.push("The auction state is not recognized.");
  }
  return { ok: errors.length === 0, errors, reason: errors[0] ?? null };
}

export function previewAuction(auction) {
  const orders = Array.isArray(auction?.orders) ? auction.orders : [];
  const activeOrders = orders.filter((order) => order.status === ORDER_ACTIVE);
  const fundedBuyBase = activeOrders
    .filter((order) => order.side === 0)
    .reduce((sum, order) => sum + BigInt(order.quantityBaseUnits), 0n);
  const fundedSellBase = activeOrders
    .filter((order) => order.side === 1)
    .reduce((sum, order) => sum + BigInt(order.quantityBaseUnits), 0n);
  let best = null;
  if (Number.isInteger(auction?.firstTickCents) && Number.isInteger(auction?.candidateTickCount)) {
    const lastTick = auction.firstTickCents + auction.candidateTickCount - 1;
    for (let priceCents = auction.firstTickCents; priceCents <= lastTick; priceCents += 1) {
      const buyEligible = activeOrders
        .filter((order) => order.side === 0 && order.limitPriceCents >= priceCents)
        .reduce((sum, order) => sum + BigInt(order.quantityBaseUnits), 0n);
      const sellEligible = activeOrders
        .filter((order) => order.side === 1 && order.limitPriceCents <= priceCents)
        .reduce((sum, order) => sum + BigInt(order.quantityBaseUnits), 0n);
      const matchedBase = buyEligible < sellEligible ? buyEligible : sellEligible;
      const imbalance = absolute(buyEligible - sellEligible);
      const candidate = {
        priceCents,
        matchedBase,
        imbalance,
        buyEligible,
        sellEligible,
        distance: absolute(priceCents - auction.openingReferenceCents),
      };
      if (candidateIsBetter(candidate, best)) best = candidate;
    }
  }
  return {
    priceCents: best?.priceCents ?? 0,
    matchedBase: best?.matchedBase ?? 0n,
    remainingImbalance: best?.imbalance ?? 0n,
    buyEligibleBase: best?.buyEligible ?? 0n,
    sellEligibleBase: best?.sellEligible ?? 0n,
    fundedBuyBase,
    fundedSellBase,
  };
}

export function orderRequirements({ side, quantityBaseUnits, limitPriceCents }) {
  const quantity = BigInt(quantityBaseUnits);
  if (side === 0) return { baseUnits: 0n, quoteUnits: quantity * BigInt(limitPriceCents) * 100n };
  return { baseUnits: quantity, quoteUnits: 0n };
}

export function canShareSetup(setup) {
  return Boolean(setup?.createSignature && setup?.openingSignature);
}

export function creatorWindowState({ walletKey, setup, error } = {}) {
  if (!setup) {
    const failure = typeof error === "string" && error.length > 0 ? error : null;
    return {
      buttonText: walletKey
        ? failure ? "Retry create window" : "Create window account"
        : "Connect wallet to create window",
      buttonDisabled: !walletKey,
      status: failure ?? (walletKey
        ? "Connected on devnet. Review the opening order requirements before creating the window account."
        : "Connect a devnet wallet to create a window account."),
    };
  }
  const ready = canShareSetup(setup);
  return {
    buttonText: ready ? "Opening order finalized" : "Window account created",
    buttonDisabled: true,
    status: ready
      ? "Opening order finalized. This window can be shared."
      : "The auction account is finalized. Finish the opening order before sharing.",
  };
}

export function sharedRoomUrl(origin, auctionAddress) {
  return new URL(`/room/?auction=${encodeURIComponent(auctionAddress)}`, origin).toString();
}
