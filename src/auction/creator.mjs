export const MIN_WINDOW_MINUTES = 1;
export const DEFAULT_WINDOW_MINUTES = 15;
export const MAX_WINDOW_MINUTES = 60;

const AUCTION_STATE_LABELS = {
  0: "open",
  1: "closed",
  2: "halted",
  3: "aborted",
};

export function cutoffSecondsFromMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < MIN_WINDOW_MINUTES || minutes > MAX_WINDOW_MINUTES) {
    throw new RangeError(`Choose an order window between ${MIN_WINDOW_MINUTES} and ${MAX_WINDOW_MINUTES} minutes.`);
  }
  return minutes * 60;
}
export function expectedLocalCloseLabel(minutes, nowMs = Date.now(), timeZone) {
  const close = new Date(nowMs + cutoffSecondsFromMinutes(minutes) * 1_000);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(close);
}

export function openingWindowStatus({ state, cutoffTime, chainTime }) {
  const stateLabel = AUCTION_STATE_LABELS[state];
  if (!stateLabel) {
    return {
      ok: false,
      reason: "unavailable",
      stateLabel: "unavailable",
      message: "The Devnet auction state could not be verified.",
    };
  }
  if (state !== 0) {
    return {
      ok: false,
      reason: "state",
      stateLabel,
      message: `The Devnet auction is ${stateLabel}, so its opening order cannot be funded.`,
    };
  }
  if (typeof cutoffTime !== "bigint" || typeof chainTime !== "bigint") {
    return { ok: false, reason: "unavailable", stateLabel, message: "The Devnet auction cutoff could not be verified." };
  }
  if (chainTime >= cutoffTime) {
    return {
      ok: false,
      reason: "expired",
      stateLabel,
      message: "The Devnet auction cutoff has passed, so its opening order cannot be funded.",
    };
  }
  return { ok: true, reason: "open", stateLabel, message: "The Devnet auction is open for its opening order." };
}

export function creatorOpeningOrderState({
  walletConnected = false,
  walletAddress = null,
  creatorAddress = null,
  setupAuctionAddress = null,
  loadedAuctionAddress = null,
  auctionState,
  cutoffTime,
  savedCutoffTime = null,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  if (!walletConnected) return { disabled: true, reason: "wallet" };
  if (walletAddress !== creatorAddress) return { disabled: true, reason: "creator-wallet" };
  const setupAuctionLoaded = Boolean(setupAuctionAddress && loadedAuctionAddress === setupAuctionAddress);
  const windowClosed = setupAuctionLoaded
    ? auctionState !== 0 || (typeof cutoffTime === "bigint" && BigInt(nowSeconds) >= cutoffTime)
    : typeof savedCutoffTime === "bigint" && BigInt(nowSeconds) >= savedCutoffTime;
  return windowClosed
    ? { disabled: true, reason: "closed" }
    : { disabled: false, reason: "ready" };
}
