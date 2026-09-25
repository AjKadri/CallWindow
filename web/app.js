import { Buffer } from "buffer/";
import {
  canSignDevnet,
  classifyDevnetProviderError,
  DevnetPreflightError,
  getInjectedWallets,
  isAuctionWindowFailure,
  isBlockhashFailure,
  readDevnetSendDiagnostics,
  signAfterDevnetPreflightWithBlockhashRetry,
  readProviderNetwork,
  requireDevnetNetwork,
  signAfterDevnetPreflight,
} from "../src/wallet/devnet.mjs";
import {
  CREATOR_ESTIMATED_FEES_LAMPORTS,
  readDevnetFunding,
} from "../src/wallet/funding.mjs";
import {
  DEFAULT_WINDOW_MINUTES,
  MAX_WINDOW_MINUTES,
  MIN_WINDOW_MINUTES,
  cutoffSecondsFromMinutes,
  creatorOpeningOrderState,
  expectedLocalCloseLabel,
  openingWindowStatus,
} from "../src/auction/creator.mjs";
import {
  canShareSetup,
  canEditOpeningOrder,
  isCreatorSetupClosed,
  creatorWindowState,
  DEMO_BASE_MINT,
  DEMO_QUOTE_MINT,
  DEVNET_PROGRAM_ID,
  MAX_ORDER_BASE_UNITS as ROOM_MAX_ORDER_BASE_UNITS,
  orderRequirements,
  orderSettlementAction,
  previewAuction,
  sharedMarketUrl,
  validateSharedAuction,
} from "../src/auction/room.mjs";

globalThis.Buffer = Buffer;

const {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} = await import("@solana/web3.js");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} = await import("@solana/spl-token");

const DEFAULT_MARKET_SYMBOL = "KALSHI";
const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_TRANSACTION_COMMITMENT = "confirmed";
const AUCTION_STATES = ["Open", "Closed · claims available", "Halted · refunds available", "Aborted · refunds available"];
const ORDER_ACTIVE = 0;
const ORDER_CANCELLED = 1;
const MAX_ORDER_BASE_UNITS = ROOM_MAX_ORDER_BASE_UNITS;
const AUCTION_ACCOUNT_SIZE = 2_168;
const TOKEN_ACCOUNT_SIZE = 165;
const AUCTION_FIRST_TICK_CENTS = 1_950;
const AUCTION_TICK_COUNT = 101;
const AUCTION_REFERENCE_CENTS = 2_000;
const CREATE_SETUP_KEY_PREFIX = "callwindow-auction-setup";
const connection = new Connection(DEVNET_RPC, "finalized");
const encoder = new TextEncoder();

const $ = (id) => document.getElementById(id);
const isDemoPage = document.body.dataset.page === "demo";
const isRoomPage = isDemoPage || document.body.dataset.page === "auction-room";
const state = {
  market: null,
  selectedMarket: null,
  proof: null,
  devnet: null,
  liveRoom: null,
  distributor: null,
  creatorDistributor: null,
  fundingNotice: "",
  auction: null,
  preview: null,
  sharedAuction: false,
  setup: null,
  walletBalances: null,
  wallet: null,
  walletKey: null,
  walletId: null,
  walletName: null,
  walletNetwork: { status: "unknown", reported: null },
  creatorFunding: null,
  creatorError: null,
  creatorNotice: null,
  creatorDebug: "",
  creatorStage: null,
  creatorBusy: false,
  busy: false,
};

const CREATOR_STAGE_LABELS = {
  validation: "Form validation",
  network: "Wallet network check",
  funding: "Devnet funding check",
  state: "Devnet auction state check",
  time: "Devnet time lookup",
  build: "Instruction build",
  preparation: "Devnet transaction preparation",
  simulation: "Devnet simulation",
  signing: "Wallet signing",
  submission: "Devnet submission",
  finalization: "Devnet finalization",
};

function isoTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "unavailable";
  return `${new Date(value).toISOString().replace("T", " ").replace("Z", " UTC")}`;
}

function formatDollars(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatRawTokenAmount(raw, decimals) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isInteger(decimals)) return "not reported";
  const amount = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatLocalDateTime(valueMs) {
  if (!Number.isFinite(valueMs)) return "unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(valueMs));
}

function formatDevnetCutoff(cutoffTime) {
  try {
    const seconds = Number(BigInt(cutoffTime));
    return `${formatLocalDateTime(seconds * 1_000)} local time (${new Date(seconds * 1_000).toISOString().replace("T", " ").replace("Z", " UTC")})`;
  } catch {
    return "unavailable";
  }
}

function compactKey(value) {
  return value ? `${value.slice(0, 5)}…${value.slice(-5)}` : "unavailable";
}

function mintName(mint) {
  if (mint === state.selectedMarket?.mint) return state.selectedMarket.symbol;
  if (mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") return "USDC";
  if (mint === state.devnet?.mints?.quote?.address) return state.devnet.mints.quote.name;
  if (mint === state.devnet?.mints?.base?.address) return state.devnet.mints.base.name;
  return compactKey(mint);
}

function demoBaseName() {
  return state.devnet?.mints?.base?.name ?? state.selectedMarket?.demo?.base?.name ?? "CallWindow test shares";
}

function demoQuoteName() {
  return state.devnet?.mints?.quote?.name ?? state.selectedMarket?.demo?.quote?.name ?? "DEMO-USD";
}

function demoAssetDisclosure() {
  return state.selectedMarket?.demo?.disclosure ?? "Solana devnet test assets with no issuer backing, rights, or monetary value.";
}

function setError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.textContent = "";
  element.hidden = true;
}

function renderCreatorReview(review = null) {
  const container = $("creator-review");
  if (!container) return;
  if (!review) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  $("creator-review-title").textContent = review.action;
  $("creator-review-network").textContent = "Solana Devnet";
  $("creator-review-assets").textContent = review.assets;
  $("creator-review-amount").textContent = review.amount;
  $("creator-review-sol").textContent = review.sol;
  $("creator-review-cutoff").textContent = review.cutoff;
  $("creator-review-note").textContent = `SOL shown in the wallet pays for Solana account rent and network fees. It does not buy ${demoBaseName()} or ${demoQuoteName()}.`;
}

function renderCreatorDebug() {
  const details = $("creator-debug");
  const text = $("creator-debug-text");
  if (!details || !text) return;
  text.textContent = state.creatorDebug;
  details.hidden = !state.creatorDebug;
}

function renderFundingNotice() {
  const notice = $("asset-notice");
  if (!notice) return;
  notice.hidden = !state.fundingNotice;
  notice.textContent = state.fundingNotice;
}

function showFundingNotice(message) {
  state.fundingNotice = message;
  renderFundingNotice();
}

function renderOrderStatus(message = "", stateName = "progress", details = "") {
  const status = $("order-status");
  const debug = $("order-debug");
  const debugText = $("order-debug-text");
  if (status) {
    status.textContent = message;
    status.dataset.state = stateName;
  }
  if (debugText) debugText.textContent = details;
  if (debug) debug.hidden = !details;
}

function renderOrderReview(review = null) {
  const container = $("order-review");
  if (!container) return;
  if (!review) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  $("order-review-title").textContent = review.action;
  $("order-review-network").textContent = "Solana Devnet";
  $("order-review-assets").textContent = review.assets;
  $("order-review-amount").textContent = review.amount;
  $("order-review-cutoff").textContent = review.cutoff;
  $("order-review-note").textContent = review.note;
}

function sharedAuctionAddress() {
  if (!isRoomPage) return null;
  if (isDemoPage && new URLSearchParams(window.location.search).has("legacyAuction")) return null;
  const value = new URLSearchParams(window.location.search).get("auction");
  if (!value) return null;
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

function sharedMarketSymbol() {
  if (!isDemoPage) return null;
  const value = new URLSearchParams(window.location.search).get("market");
  return value && /^[A-Z0-9]+$/.test(value) ? value : null;
}

function legacyAuctionAddress() {
  if (!isDemoPage) return null;
  const value = new URLSearchParams(window.location.search).get("legacyAuction");
  return value && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
}

function activeMarketSymbol() {
  return state.selectedMarket?.symbol ?? sharedMarketSymbol();
}

function creatorSetupKey(symbol = activeMarketSymbol()) {
  return symbol ? `${CREATE_SETUP_KEY_PREFIX}:${symbol}` : `${CREATE_SETUP_KEY_PREFIX}:legacy`;
}

function renderRoomHero() {
  if (!isRoomPage) return;
  const legacy = legacyAuctionAddress();
  const shared = Boolean(sharedAuctionAddress());
  const title = $("room-hero-title");
  const copy = $("room-hero-copy");
  if (title) title.textContent = legacy
    ? "Choose a market before joining a window."
    : shared ? "Join this funded Devnet window." : "Create a funded Devnet window.";
  if (copy) {
    copy.textContent = legacy
      ? `This older Auction Room link (${compactKey(legacy)}) is not assigned to a PreStocks market. Choose a verified product below; CallWindow will not infer one from a generic auction address.`
      : shared
      ? "This link opens one verified CallWindow auction account. Connect a wallet, check your demo balances, submit a funded limit order before the cutoff, and follow the result through close, claim, or refund."
      : "Choose a verified market, set an opening order with its named CallWindow test mint, and share the window after it finalizes. Other wallets can join before the cutoff, then follow the result through close, claim, or refund.";
  }
}

function readAuctionSetup() {
  try {
    const setup = JSON.parse(sessionStorage.getItem(creatorSetupKey()) ?? "null");
    if (!setup || typeof setup.auctionAddress !== "string") return null;
    if (Number.isInteger(setup.durationMinutes)) return setup;
    if (Number.isInteger(setup.durationSeconds) && setup.durationSeconds > 0) {
      return { ...setup, durationMinutes: Math.max(MIN_WINDOW_MINUTES, Math.round(setup.durationSeconds / 60)) };
    }
    return setup;
  } catch {
    return null;
  }
}

function persistAuctionSetup(setup) {
  state.setup = setup;
  sessionStorage.setItem(creatorSetupKey(setup.marketSymbol), JSON.stringify(setup));
}

function clearAuctionSetup() {
  state.setup = null;
  sessionStorage.removeItem(creatorSetupKey());
}

function marketOptions() {
  if (Array.isArray(state.market?.marketOptions)) return state.market.marketOptions;
  return (state.market?.products ?? []).map((product) => ({ ...product, status: "available" }));
}

function renderMarketCards() {
  const container = $("market-cards");
  if (!container) return;
  container.replaceChildren();
  const options = marketOptions();
  if (!options.length) {
    const message = document.createElement("p");
    message.className = "empty-state";
    message.textContent = "No supported market records are available right now.";
    container.append(message);
    return;
  }
  for (const option of options) {
    const card = document.createElement("button");
    card.type = "button";
    const selected = state.selectedMarket?.symbol === option.symbol;
    card.className = `market-card${selected ? " is-selected" : ""}`;
    card.dataset.symbol = option.symbol;
    card.disabled = option.status !== "available";
    card.setAttribute("aria-label", `${option.name} ${option.symbol}${selected ? " selected" : ""}`);
    const top = document.createElement("span");
    top.className = "market-card-top";
    const name = document.createElement("strong");
    name.textContent = option.name;
    const symbol = document.createElement("span");
    symbol.className = "ticker-badge";
    symbol.textContent = option.symbol;
    top.append(name, symbol);
    const status = document.createElement("span");
    status.className = "market-card-status";
    status.textContent = option.status !== "available" ? "Unavailable" : selected ? "Selected market" : "Verified market window";
    const mint = document.createElement("code");
    mint.textContent = option.status === "available"
      ? `Devnet test mint: ${option.demo.base.name}`
      : option.reason ?? "The official record could not be verified.";
    card.append(top, status, mint);
    container.append(card);
  }
}

function renderMarketRecord() {
  const record = state.selectedMarket;
  if (!record) return;
  $("market-name").textContent = record.name;
  $("market-description").textContent = record.description ?? "Official issuer data verified against the current PreStocks API.";
  $("market-symbol").textContent = record.symbol;
  $("selected-mint").textContent = record.mint;
  $("market-time").textContent = isoTime(state.market.observedAt);
  $("market-time").dateTime = state.market.observedAt ?? "";
  $("market-issuer-link").href = record.issuerUrl;
  $("market-issuer-link").textContent = "View official page ↗";
  if ($("demo-test-base")) $("demo-test-base").textContent = `${record.demo.base.name} · ${record.demo.base.address}`;
  if ($("demo-test-quote")) $("demo-test-quote").textContent = `${record.demo.quote.name} · ${record.demo.quote.address}`;
  if ($("room-base-label")) $("room-base-label").textContent = record.demo.base.name;
  if ($("room-quote-label")) $("room-quote-label").textContent = record.demo.quote.name;
  renderMarketCards();
}

function resetMarketHeader() {
  $("market-symbol").textContent = "—";
  $("selected-mint").textContent = "unavailable";
  $("market-time").textContent = isoTime(state.market?.observedAt);
  $("market-time").removeAttribute("datetime");
  $("market-issuer-link").removeAttribute("href");
  $("market-issuer-link").textContent = "unavailable";
  if ($("demo-test-base")) $("demo-test-base").textContent = "unavailable";
  if ($("demo-test-quote")) $("demo-test-quote").textContent = "unavailable";
  if ($("room-base-label")) $("room-base-label").textContent = "Selected test shares";
  if ($("room-quote-label")) $("room-quote-label").textContent = "DEMO-USD";
}

function setMarketUnavailable(message) {
  state.selectedMarket = null;
  $("market-name").textContent = "PreStocks records unavailable";
  $("market-description").textContent = "The official product list could not be verified.";
  resetMarketHeader();
  $("market-selection-note").textContent = "The supported market cards are disabled until official records can be verified.";
  renderMarketCards();
  setError($("market-error"), message);
}

function setMarketSelectionUnavailable(message) {
  state.selectedMarket = null;
  $("market-name").textContent = "No verified market selected";
  $("market-description").textContent = message;
  resetMarketHeader();
  $("market-selection-note").textContent = message;
  renderMarketCards();
  setError($("market-error"), message);
}

function selectMarket(symbol) {
  const record = state.market?.products?.find((product) => product.symbol === symbol);
  if (!record) {
    setMarketSelectionUnavailable("Choose one of the enabled cards. An unavailable card cannot be selected until its official record and exact mint match.");
    return;
  }
  state.selectedMarket = record;
  setVerifiedDevnetState(null, record);
  state.auction = null;
  state.distributor = null;
  state.setup = readAuctionSetup();
  clearError($("market-error"));
  $("market-selection-note").textContent = `${record.symbol} is verified. Its named Devnet test mint and auction are separate from the official mainnet record.`;
  renderMarketRecord();
  if (isDemoPage) {
    const query = new URLSearchParams(window.location.search);
    const queryMarket = query.get("market");
    if (queryMarket !== record.symbol || legacyAuctionAddress()) {
      history.replaceState(null, "", `/demo/?market=${encodeURIComponent(record.symbol)}`);
    }
    loadAuction();
  }
}

async function loadMarket() {
  const error = $("market-error");
  clearError(error);
  try {
    const response = await fetch("/api/market", { cache: "no-store" });
    const market = await response.json();
    state.market = market;
    if (market.status !== "available") {
      setMarketUnavailable(market.reason ?? "The official PreStocks records could not be loaded.");
      return;
    }
    const products = market.products ?? [];
    renderMarketCards();
    const requested = sharedMarketSymbol();
    const selected = products.find((product) => product.symbol === requested)
      ?? products.find((product) => product.symbol === DEFAULT_MARKET_SYMBOL)
      ?? products[0];
    if (selected) selectMarket(selected.symbol);
    else setMarketSelectionUnavailable("No supported market has a verified official record right now.");
  } catch (errorValue) {
    state.market = { observedAt: new Date().toISOString() };
    setMarketUnavailable(errorValue instanceof Error ? errorValue.message : "Market request failed.");
  }
}


function decodeAuction(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  const readKey = () => {
    const key = new PublicKey(data.slice(offset, offset + 32)).toBase58();
    offset += 32;
    return key;
  };
  const readU8 = () => data[offset++];
  const readU16 = () => { const value = view.getUint16(offset, true); offset += 2; return value; };
  const readU64 = () => { const value = view.getBigUint64(offset, true); offset += 8; return value; };
  const readI64 = () => { const value = view.getBigInt64(offset, true); offset += 8; return value; };
  const auction = {
    authority: readKey(),
    baseMint: readKey(),
    quoteMint: readKey(),
    baseVault: readKey(),
    quoteVault: readKey(),
    auctionId: readU64(),
    cutoffTime: readI64(),
    abortAfter: readI64(),
    openingReferenceCents: readU16(),
    firstTickCents: readU16(),
    candidateTickCount: readU8(),
    orderCount: readU8(),
    state: readU8(),
    clearingPriceCents: readU16(),
    matchedBase: readU64(),
    claimedCount: readU8(),
  };
  readU8();
  readU8();
  const orderStorageLength = view.getUint32(offset, true);
  offset += 4;
  if (orderStorageLength !== 32 || auction.orderCount > orderStorageLength) {
    throw new Error("The auction account did not match the bounded order layout.");
  }
  auction.orders = [];
  for (let index = 0; index < auction.orderCount; index += 1) {
    const order = {
      index,
      owner: readKey(),
      side: readU8(),
      status: readU8(),
      limitPriceCents: readU16(),
      quantityBaseUnits: readU64(),
      escrowedQuote: readU64(),
      filledBaseUnits: readU64(),
      claimed: data[offset++] === 1,
    };
    auction.orders.push(order);
  }
  return auction;
}

function formatShares(baseUnits) {
  const whole = baseUnits / 100n;
  const fraction = (baseUnits % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatQuoteUnits(quoteUnits) {
  const whole = quoteUnits / 1_000_000n;
  const fraction = (quoteUnits % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function signatureAnchor(signature) {
  const link = document.createElement("a");
  link.href = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = compactKey(signature);
  return link;
}

function renderProof() {
  const container = $("devnet-proof");
  container.replaceChildren();
  const proof = state.proof;
  const transactions = [...(state.liveRoom?.seededOrders?.transactions ?? []), ...(proof?.transactions ?? [])];
  try {
    const recent = JSON.parse(sessionStorage.getItem("callwindow-devnet-transactions") ?? "[]");
    transactions.push(...recent);
  } catch {}
  if (!transactions.length) {
    const note = document.createElement("p");
    note.textContent = "Historical proof links are listed above. Wallet actions will add current finalized signatures here.";
    container.append(note);
    return;
  }
  const list = document.createElement("div");
  list.className = "proof-list";
  for (const item of transactions) {
    const entry = document.createElement("div");
    entry.append(document.createTextNode(`${item.label ?? item.action ?? "Transaction"} · `));
    if (item.signature) entry.append(signatureAnchor(item.signature));
    const status = document.createElement("span");
    status.textContent = ` · ${item.status ?? "finalized"}`;
    entry.append(status);
    list.append(entry);
  }
  container.append(list);
  const closeCosts = proof?.closingCost;
  const units = proof?.closingComputeUnits;
  if (closeCosts?.matched || Number.isInteger(units)) {
    const compute = document.createElement("p");
    compute.className = "action-note";
    const costLine = (label, cost) => {
      const amount = Number.isInteger(cost?.computeUnitsConsumed)
        ? `${new Intl.NumberFormat("en-US").format(cost.computeUnitsConsumed)} compute units`
        : "compute units unavailable";
      const fee = Number.isInteger(cost?.feeLamports)
        ? `${new Intl.NumberFormat("en-US").format(cost.feeLamports)} lamports in transaction fee`
        : "fee unavailable";
      return `${label}: ${amount}, ${fee}`;
    };
    const measuredCosts = [
      costLine("matched", closeCosts?.matched ?? {}),
      costLine("no-cross refund", closeCosts?.noCrossRefund ?? {}),
    ];
    if (closeCosts?.maxBounds) {
      measuredCosts.push(costLine("32 orders / 101 ticks", closeCosts.maxBounds));
    }
    compute.textContent = closeCosts?.matched
      ? `Finalized close cost · ${measuredCosts.join("; ")}.`
      : `Finalized close consumed ${new Intl.NumberFormat("en-US").format(units)} compute units.`;
    container.append(compute);
  }
}

function renderRoomCountdown() {
  const countdown = $("auction-countdown");
  if (!countdown) return;
  if (!state.auction) {
    countdown.textContent = "No live window is open";
    return;
  }
  const auction = state.auction;
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (auction.state === 0 && now < auction.cutoffTime) {
    const remaining = Number(auction.cutoffTime - now);
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    countdown.textContent = "Closes in " + minutes + "m " + String(seconds).padStart(2, "0") + "s";
  } else if (auction.state === 0) {
    countdown.textContent = "Ready to close";
  } else if (auction.state === 1) {
    countdown.textContent = "Closed. Claim a fill or refund.";
  } else {
    countdown.textContent = "Refunds available after the halted state.";
  }
}

function walletCanTransact() {
  return Boolean(state.walletKey && requireDevnetNetwork(state.walletNetwork, { walletName: state.walletName ?? "Selected wallet" }).ok);
}

function walletNetworkReason() {
  return requireDevnetNetwork(state.walletNetwork, { walletName: state.walletName ?? "Selected wallet" }).reason;
}

function renderWalletNetworkState() {
  const help = $("wallet-network-help");
  if (!state.walletKey) {
    if (help) help.hidden = true;
    return;
  }
  if (state.walletNetwork?.status === "devnet") {
    if (help) help.hidden = true;
    return;
  }
  if (help) {
    help.hidden = false;
    help.textContent = state.walletNetwork?.status === "unknown"
      ? walletNetworkReason()
      : `In ${state.walletName ?? "your wallet"}, select Solana Devnet, disconnect this site, then reconnect.`;
  }
  if ($("wallet-status") && state.walletKey) $("wallet-status").textContent = walletNetworkReason();
}

async function requireConnectedDevnetWallet() {
  if (!state.wallet || !state.walletKey) throw new Error("Connect a devnet wallet first.");
  state.walletNetwork = await readProviderNetwork(state.wallet);
  renderWalletNetworkState();
  renderAuctionSetup();
  const requirement = requireDevnetNetwork(state.walletNetwork, { walletName: state.walletName ?? "Selected wallet" });
  if (!requirement.ok) throw new Error(requirement.reason);
}

function renderWalletChoices() {
  const connectButton = $("connect-wallet");
  const chooser = $("wallet-chooser");
  const status = $("wallet-choice-status");
  const wallets = getInjectedWallets();
  const signableWallets = wallets.filter((wallet) => canSignDevnet(wallet.provider));
  if (connectButton) {
    connectButton.textContent = state.walletKey && state.walletName
      ? `Change wallet · ${state.walletName} · ${compactKey(state.walletKey.toBase58())}`
      : "Connect wallet";
    connectButton.setAttribute("aria-expanded", String(Boolean(chooser && !chooser.hidden)));
  }
  for (const id of ["phantom", "solflare"]) {
    const button = $("connect-" + id);
    if (!button) continue;
    const wallet = wallets.find((candidate) => candidate.id === id);
    const canSign = Boolean(wallet && canSignDevnet(wallet.provider));
    button.disabled = !canSign;
    button.textContent = `Connect ${id === "phantom" ? "Phantom" : "Solflare"}`;
    button.title = wallet
      ? canSign ? "Connect this wallet for Devnet-only signing." : `${wallet.name} is detected but does not expose signTransaction.`
      : `${id === "phantom" ? "Phantom" : "Solflare"} is not detected in this browser.`;
  }
  if (status) {
    status.textContent = state.walletKey && state.walletName
      ? `${state.walletName} ${compactKey(state.walletKey.toBase58())} connected. It signs only the Devnet test transaction.`
      : !wallets.length
        ? "No supported wallet detected. Install Phantom or Solflare, then reload this page."
        : !signableWallets.length
          ? "A supported wallet was detected, but it cannot sign Devnet transactions in this browser."
          : "Choose Phantom or Solflare. Each action names the wallet it will connect.";
  }
}

function openWalletChooser() {
  const chooser = $("wallet-chooser");
  if (!chooser) return;
  chooser.hidden = false;
  renderWalletChoices();
  const firstAvailable = ["connect-phantom", "connect-solflare"].map((id) => $(id)).find((button) => button && !button.disabled);
  (firstAvailable ?? $("close-wallet-chooser"))?.focus();
}

function closeWalletChooser() {
  const chooser = $("wallet-chooser");
  if (!chooser) return;
  chooser.hidden = true;
  renderWalletChoices();
  $("connect-wallet")?.focus();
}

function resetWalletForChoice(id) {
  state.wallet = null;
  state.walletKey = null;
  state.walletId = id;
  state.walletName = null;
  state.walletNetwork = { status: "unknown", reported: null };
  state.walletBalances = null;
  state.creatorFunding = null;
  state.creatorError = null;
  state.creatorNotice = null;
  state.creatorStage = null;
  state.fundingNotice = "";
  renderFundingNotice();
  renderOrderStatus();
  renderOrderReview(null);
  $("wallet-status").textContent = "Wallet selected. Connect it to continue.";
  renderWalletNetworkState();
  renderWalletChoices();
  renderAuction();
  renderAuctionSetup();
  updateCreateEstimate();
}

function renderFundingAvailability() {
  if (!isRoomPage) return;
  const button = $("get-test-assets");
  const status = $("funding-status");
  if (!button || !status) return;
  const setup = state.setup ?? readAuctionSetup();
  const creatorSetup = !state.sharedAuction && setup && !canShareSetup(setup) ? setup : null;
  const distributor = creatorSetup ? state.creatorDistributor : state.distributor;
  if (state.walletKey && !walletCanTransact()) {
    button.disabled = true;
    button.textContent = `Switch ${state.walletName ?? "wallet"} to Devnet`;
    status.textContent = walletNetworkReason();
    return;
  }
  if (state.sharedAuction) {
    const windowOpen = state.auction?.state === 0
      && BigInt(Math.floor(Date.now() / 1000)) < state.auction.cutoffTime;
    if (!windowOpen) {
      if (isDemoPage && distributor?.scope === "market" && distributor.status === "available") {
        button.disabled = false;
        button.textContent = "Get assets for next window";
        status.textContent = `This ${demoBaseName()} window is closed. Claim once per wallet to prepare for the next ${state.selectedMarket?.symbol ?? "market"} window. No new orders can enter this closed window.`;
        return;
      }
      button.disabled = true;
      button.textContent = "Test assets unavailable";
      status.textContent = distributor?.reason ?? "This shared window is no longer open for test-asset claims.";
      return;
    }
    if (!distributor || distributor.status !== "available") {
      button.disabled = true;
      button.textContent = "Test assets unavailable";
      status.textContent = distributor?.reason ?? "The shared test-asset distributor is unavailable.";
      return;
    }
    button.disabled = false;
    button.textContent = "Get test assets";
    status.textContent = distributor.remainingClaims + " global distribution claim" + (distributor.remainingClaims === 1 ? "" : "s") + " remain. One claim per wallet across shared windows.";
    return;
  }
  if (creatorSetup) {
    if (!distributor || distributor.status !== "available") {
      button.disabled = true;
      button.textContent = "Test assets unavailable";
      status.textContent = distributor?.reason ?? "The creator window test-asset distributor is unavailable.";
      return;
    }
    button.disabled = false;
    button.textContent = "Get test assets";
    status.textContent = distributor.remainingClaims + " global distribution claim" + (distributor.remainingClaims === 1 ? "" : "s") + " remain to fund this opening order. One claim per wallet across shared windows.";
    return;
  }
  if (!distributor || distributor.status !== "available") {
    if (isDemoPage && distributor?.scope === "market") {
      button.disabled = true;
      button.textContent = "Test assets unavailable";
      status.textContent = distributor.reason ?? "The market test-asset distributor is unavailable.";
      return;
    }
    button.disabled = true;
    button.textContent = "Test assets unavailable";
    status.textContent = distributor?.reason ?? "No public Auction Room is open.";
    return;
  }
  if (isDemoPage && distributor.scope === "market") {
    button.disabled = false;
    button.textContent = "Get assets for next window";
    status.textContent = `${distributor.remainingClaims} global distribution claim${distributor.remainingClaims === 1 ? "" : "s"} remain. Claim once per wallet to prepare this market's next Devnet window.`;
    return;
  }
  button.disabled = false;
  button.textContent = "Get test assets";
  status.textContent = distributor.remainingClaims + " distribution claim" + (distributor.remainingClaims === 1 ? "" : "s") + " remain for this window. One claim per wallet.";
}

function displayUnavailableAuction(reason) {
  state.devnet = null;
  state.liveRoom = null;
  state.auction = null;
  state.preview = null;
  state.sharedAuction = false;
  $("auction-status").textContent = "Devnet auction unavailable";
  $("auction-summary").textContent = reason;
  $("candidate-range").textContent = "—";
  $("opening-reference").textContent = "—";
  $("clearing-price").textContent = "—";
  $("matched-quantity").textContent = "—";
  if ($("funded-buy-interest")) $("funded-buy-interest").textContent = "—";
  if ($("funded-sell-interest")) $("funded-sell-interest").textContent = "—";
  if ($("provisional-clearing")) $("provisional-clearing").textContent = "—";
  if ($("provisional-matched")) $("provisional-matched").textContent = "—";
  if ($("remaining-imbalance")) $("remaining-imbalance").textContent = "—";
  if ($("room-order-count")) $("room-order-count").textContent = "—";
  if ($("room-cutoff")) $("room-cutoff").textContent = "—";
  if ($("room-next-action")) $("room-next-action").textContent = "Check back later";
  if ($("room-state-note")) $("room-state-note").textContent = reason;
  $("order-rows").innerHTML = '<tr><td colspan="6" class="empty-table">No devnet auction loaded.</td></tr>';
  $("order-form").hidden = true;
  $("auction-actions").hidden = true;
  renderRoomCountdown();
  renderFundingAvailability();
  if (reason) setError($("devnet-error"), reason);
  renderProof();
}

async function readDevnetReference() {
  try {
    const response = await fetch("/api/devnet", { cache: "no-store" });
    return await response.json();
  } catch {
    return null;
  }
}

async function readSharedDistributorStatus(address) {
  try {
    const query = new URLSearchParams({ auctionAddress: address });
    const response = await fetch(`/api/auction-room/shared-status?${query}`, { cache: "no-store" });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return {
        status: "unavailable",
        reason: `The test-asset distributor service returned HTTP ${response.status}. Restart the CallWindow server, then reload this room.`,
      };
    }
    const result = await response.json();
    if (!response.ok) {
      return { status: "unavailable", ...result };
    }
    return result;
  } catch {
    return { status: "unavailable", reason: "The shared test-asset distributor status is unavailable." };
  }
}

async function readFinalizedDevnetTime() {
  const slot = await connection.getSlot("finalized");
  const chainTime = await connection.getBlockTime(slot);
  if (!Number.isSafeInteger(chainTime)) throw new Error("Devnet time was unavailable. Try again.");
  return BigInt(chainTime);
}

function setVerifiedDevnetState(auctionAddress, market = state.selectedMarket) {
  const demo = market?.demo;
  if (!demo) throw new Error("The selected PreStocks product has no verified CallWindow test-asset mapping.");
  state.devnet = {
    network: "devnet",
    programId: DEVNET_PROGRAM_ID,
    auctionAddress,
    marketSymbol: market.symbol,
    mainnetMint: market.mint,
    mints: {
      base: { ...demo.base },
      quote: { ...demo.quote },
    },
  };
}

async function readMarketDistributorStatus(symbol, address) {
  try {
    const query = new URLSearchParams({ symbol });
    if (address) query.set("auctionAddress", address);
    if (state.walletKey) query.set("wallet", state.walletKey.toBase58());
    const response = await fetch(`/api/auction-room/market-status?${query}`, { cache: "no-store" });
    const result = await response.json();
    return result.distributor ?? result;
  } catch {
    return { status: "unavailable", reason: "The market test-asset distributor status is unavailable." };
  }
}

async function readMarketWindowReference(symbol) {
  try {
    const query = new URLSearchParams({ symbol });
    const response = await fetch(`/api/auction-room/market-status?${query}`, { cache: "no-store" });
    const result = await response.json();
    return response.ok ? result : { status: "unavailable", reason: result.reason ?? "The market window reference is unavailable." };
  } catch {
    return { status: "unavailable", reason: "The market window reference is unavailable." };
  }
}

function renderMarketAuctionUnavailable(reason) {
  const marketDistributor = state.distributor?.scope === "market" ? state.distributor : null;
  state.auction = null;
  state.sharedAuction = false;
  state.liveRoom = null;
  state.distributor = marketDistributor;
  if ($("auction-status")) $("auction-status").textContent = "No shared window for this market";
  if ($("auction-summary")) $("auction-summary").textContent = reason;
  if ($("order-rows")) $("order-rows").innerHTML = '<tr><td colspan="6" class="empty-table">Create and finalize a funded opening order to share this market window.</td></tr>';
  if ($("order-form")) $("order-form").hidden = true;
  if ($("auction-actions")) $("auction-actions").hidden = true;
  setError($("devnet-error"), reason);
  renderFundingAvailability();
  renderAuctionSetup();
}

async function loadMarketAuction(address, symbol) {
  const market = state.market?.products?.find((product) => product.symbol === symbol);
  if (!market?.demo) throw new Error("The selected product has no verified CallWindow test-asset mapping.");
  let marketReference = null;
  if (!address && !legacyAuctionAddress()) {
    marketReference = await readMarketWindowReference(symbol);
    state.distributor = marketReference.distributor ?? null;
    if (marketReference.auctionAddress) address = marketReference.auctionAddress;
    if (!address) {
      setVerifiedDevnetState(null, market);
      renderMarketAuctionUnavailable(marketReference.reason ?? `No shared Devnet window is configured for ${symbol} yet. Create and finalize the opening order below to make the market URL shareable.`);
      return null;
    }
  }
  setVerifiedDevnetState(address, market);
  state.sharedAuction = Boolean(address);
  state.liveRoom = address ? { source: "shared", auctionAddress: address, status: "shared", marketSymbol: symbol } : null;
  if (!address) {
    renderMarketAuctionUnavailable(`No shared Devnet window is configured for ${symbol} yet. Create and finalize the opening order below to make the market URL shareable.`);
    return null;
  }
  state.distributor = await readMarketDistributorStatus(symbol, address);
  const result = await readDevnetReference();
  state.proof = result?.status === "available" ? result.historicalProof : null;
  let account;
  try {
    account = await connection.getAccountInfo(new PublicKey(address), "finalized");
  } catch {
    renderMarketAuctionUnavailable("The market auction state is currently unavailable on devnet. You can still prepare this market's test assets for its next window.");
    return null;
  }
  if (!account) {
    renderMarketAuctionUnavailable("This market auction is not available on devnet. You can still prepare this market's test assets for its next window.");
    return null;
  }
  const auction = decodeAuction(account.data);
  const validation = validateSharedAuction(auction, {
    accountOwner: account.owner.toBase58(),
    programId: DEVNET_PROGRAM_ID,
    baseMint: market.demo.base.address,
    quoteMint: market.demo.quote.address,
  });
  if (!validation.ok) throw new Error(validation.reason);
  state.auction = auction;
  renderFundingAvailability();
  renderProof();
  renderAuction();
  refreshWalletBalances();
  return auction;
}

async function loadSharedAuction(address) {
  const symbol = activeMarketSymbol();
  if (isDemoPage) return loadMarketAuction(address, symbol);
  throw new Error("Legacy Auction Room links must be opened from the Demo market URL.");
}

async function refreshOpeningWindow(setup) {
  const auction = await loadSharedAuction(setup.auctionAddress);
  const chainTime = await readFinalizedDevnetTime();
  const check = openingWindowStatus({
    state: auction?.state,
    cutoffTime: auction?.cutoffTime,
    chainTime,
  });
  if (!check.ok) {
    const stateLabel = AUCTION_STATES[auction?.state] ?? "Unavailable";
    const error = new Error(`${check.message} Actual Devnet state: ${stateLabel}. Cutoff: ${formatDevnetCutoff(auction?.cutoffTime)}. Discard the stale local setup below to start a new window. This only clears browser state and does not recover on-chain account rent.`);
    error.setupUsable = false;
    throw error;
  }
  return { auction, chainTime };
}

async function loadOperatorAuction(result) {
  if (result.status !== "available") {
    state.proof = null;
    state.distributor = result.distributor ?? null;
    renderFundingAvailability();
    displayUnavailableAuction(result.reason ?? "No devnet auction is configured.");
    return;
  }
  const proof = result.historicalProof;
  const liveRoom = result.liveRoom;
  const current = liveRoom ?? result.currentReference;
  state.distributor = result.distributor ?? null;
  renderFundingAvailability();
  if (proof?.network !== "devnet" || current?.network !== "devnet"
    || current.programId !== DEVNET_PROGRAM_ID
    || !current.programId || !current.auctionAddress
    || current.mints?.base?.name !== "DEMO-EQUITY"
    || current.mints?.quote?.name !== "DEMO-USD"
    || proof.historicalAuction?.state !== "closed and claimed") {
    state.proof = null;
    displayUnavailableAuction("The public proof did not identify the expected closed devnet demo and test mints.");
    return;
  }
  state.proof = proof;
  state.sharedAuction = false;
  state.liveRoom = liveRoom;
  state.devnet = current;
  renderProof();
  const account = await connection.getAccountInfo(new PublicKey(current.auctionAddress), "finalized");
  if (!account) {
    displayUnavailableAuction("Current devnet auction state is unavailable. Historical proof remains available below.");
    return;
  }
  const auction = decodeAuction(account.data);
  const validation = validateSharedAuction(auction, {
    accountOwner: account.owner.toBase58(),
    programId: current.programId,
  });
  if (!validation.ok) {
    displayUnavailableAuction(validation.reason);
    return;
  }
  state.auction = auction;
  renderAuction();
  refreshWalletBalances();
  renderProof();
}

async function loadAuction() {
  if (state.busy || state.creatorBusy) return;
  clearError($("devnet-error"));
  try {
    if (isDemoPage) {
      const symbol = activeMarketSymbol();
      if (!symbol) {
        renderMarketAuctionUnavailable("Choose a verified PreStocks product before opening a Devnet window.");
      } else if (legacyAuctionAddress()) {
        renderMarketAuctionUnavailable(`This legacy Auction Room link is not assigned to ${symbol}. Choose a verified market URL or create a new ${symbol} window here.`);
      } else {
        await loadMarketAuction(sharedAuctionAddress(), symbol);
        state.setup = state.setup ?? readAuctionSetup();
        state.creatorDistributor = state.setup && !canShareSetup(state.setup)
          ? await readMarketDistributorStatus(symbol, state.setup.auctionAddress)
          : null;
        renderFundingAvailability();
      }
    } else if (isRoomPage && new URLSearchParams(window.location.search).has("auction")) {
      throw new Error("This legacy Auction Room link is no longer market-scoped. Choose a product in Demo.");
    } else {
      await loadOperatorAuction(await readDevnetReference() ?? { status: "unavailable", reason: "Devnet state request failed." });
      state.setup = state.setup ?? readAuctionSetup();
      state.creatorDistributor = state.setup && !canShareSetup(state.setup)
        ? await readSharedDistributorStatus(state.setup.auctionAddress)
        : null;
      renderFundingAvailability();
    }
    renderAuctionSetup();
  } catch (errorValue) {
    displayUnavailableAuction(errorValue instanceof Error ? errorValue.message : "Devnet state request failed.");
    renderAuctionSetup();
  }
}

function renderAuction() {
  const auction = state.auction;
  if (!auction) return;
  state.preview = previewAuction(auction);
  const lastTick = auction.firstTickCents + auction.candidateTickCount - 1;
  const status = AUCTION_STATES[auction.state] ?? "Unknown state";
  const cutoff = new Date(Number(auction.cutoffTime) * 1000).toISOString().replace("T", " ").replace("Z", " UTC");
  $("auction-status").textContent = status;
  $("auction-summary").textContent = (state.sharedAuction ? "Shared creator window · " : "Operator test room · ")
    + "Cutoff " + cutoff + " · " + auction.orderCount + " of 32 orders. Orders can change until cutoff.";
  $("candidate-range").textContent = `${formatDollars(auction.firstTickCents / 100)}–${formatDollars(lastTick / 100)}`;
  $("opening-reference").textContent = formatDollars(auction.openingReferenceCents / 100);
  const provisional = auction.state === 0;
  const displayedClearingPrice = provisional ? state.preview.priceCents : auction.clearingPriceCents;
  const displayedMatchedQuantity = provisional ? state.preview.matchedBase : auction.matchedBase;
  $("clearing-price").textContent = displayedClearingPrice > 0 ? formatDollars(displayedClearingPrice / 100) : "No cross";
  $("matched-quantity").textContent = formatShares(displayedMatchedQuantity);
  if ($("clearing-price-label")) $("clearing-price-label").textContent = provisional ? "Provisional clear" : "Final clearing price";
  if ($("matched-quantity-label")) $("matched-quantity-label").textContent = provisional ? "Provisional match" : "Final matched quantity";
  if ($("provisional-clearing-label")) $("provisional-clearing-label").textContent = provisional ? "Provisional clear" : "Final clear";
  if ($("provisional-clearing-note")) $("provisional-clearing-note").textContent = provisional ? "can change before cutoff" : "final on-chain close";
  if ($("provisional-matched-label")) $("provisional-matched-label").textContent = provisional ? "Provisional match" : "Final matched";
  if ($("provisional-matched-note")) $("provisional-matched-note").textContent = provisional ? "before cutoff" : "on-chain close";
  if ($("remaining-imbalance-label")) $("remaining-imbalance-label").textContent = provisional ? "Remaining imbalance" : "Final imbalance";
  if ($("remaining-imbalance-note")) $("remaining-imbalance-note").textContent = provisional ? "not currently matched" : "after close";
  if ($("funded-buy-interest")) $("funded-buy-interest").textContent = formatShares(state.preview.fundedBuyBase);
  if ($("funded-sell-interest")) $("funded-sell-interest").textContent = formatShares(state.preview.fundedSellBase);
  if ($("provisional-clearing")) $("provisional-clearing").textContent = state.preview.priceCents > 0 ? formatDollars(state.preview.priceCents / 100) : "No cross";
  if ($("provisional-matched")) $("provisional-matched").textContent = formatShares(state.preview.matchedBase);
  if ($("remaining-imbalance")) $("remaining-imbalance").textContent = formatShares(state.preview.remainingImbalance);
  if ($("room-order-count")) $("room-order-count").textContent = auction.orderCount + " / 32";
  if ($("room-cutoff")) $("room-cutoff").textContent = cutoff;
  renderRoomCountdown();
  const roomReady = !isRoomPage || ((Boolean(state.liveRoom) || state.sharedAuction) && auction.state === 0);
  $("order-form").hidden = !roomReady;
  renderOrderRows();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const windowOpen = auction.state === 0 && now < auction.cutoffTime;
  const canClose = auction.state === 0 && now >= auction.cutoffTime;
  const canAbort = [0, 1, 2].includes(auction.state) && auction.claimedCount === 0 && now >= auction.abortAfter;
  $("auction-actions").hidden = !canClose && !canAbort;
  $("close-auction").hidden = !canClose;
  $("abort-auction").hidden = !canAbort;
  $("action-note").textContent = canClose
    ? "After the cutoff, any Devnet wallet can close the window. Owners then claim the matched result or a refund."
    : canAbort ? "Anyone can abort after 30 minutes if no claim has started." : "";
  if ($("room-next-action")) {
    $("room-next-action").textContent = windowOpen
      ? walletCanTransact() ? "Place a limit order" : "Connect a devnet wallet"
      : auction.state === 1 ? "Claim or refund" : auction.state === 0 ? "Close the window" : "Refund available";
  }
  if ($("room-state-note")) {
    $("room-state-note").textContent = windowOpen
      ? "Orders can be added or cancelled before the cutoff. After it, close the window and wait for finalization."
      : auction.state === 1 ? "The close is finalized. Claim a matched result or refund for an order owned by your wallet."
        : auction.state === 0 ? "The cutoff has passed. Close the window, then claim or refund your order."
          : "The program state exposes refund actions where applicable.";
  }
  const orderButton = $("submit-order");
  orderButton.disabled = !walletCanTransact() || !windowOpen;
  orderButton.textContent = !state.walletKey
    ? "Connect wallet to continue"
    : !walletCanTransact() ? `Switch ${state.walletName ?? "wallet"} to Devnet`
    : windowOpen ? "Review and submit devnet order" : "Order window is closed";
  updateEscrowEstimate();
}

function renderOrderRows() {
  const body = $("order-rows");
  body.replaceChildren();
  if (!state.auction.orders.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty-table";
    cell.textContent = "No orders have been placed.";
    row.append(cell);
    body.append(row);
    return;
  }
  for (const order of state.auction.orders) {
    const row = document.createElement("tr");
    const isOwner = state.walletKey && order.owner === state.walletKey.toBase58();
    const values = [
      [order.side === 0 ? "BUY" : "SELL", order.side === 0 ? "side-buy" : "side-sell"],
      [formatDollars(order.limitPriceCents / 100), ""],
      [`${formatShares(order.quantityBaseUnits)} shares`, ""],
      [`${formatShares(order.filledBaseUnits)} shares`, ""],
      [order.claimed
        ? (order.status === ORDER_CANCELLED ? "Cancelled" : "Claimed")
        : state.auction.state === 0 && order.status === ORDER_ACTIVE
          ? "Open"
          : state.auction.state === 1
            ? (order.filledBaseUnits > 0n ? (isOwner ? "Filled · claimable" : "Filled · claimable by owner") : (isOwner ? "Refundable" : "Refundable by owner"))
            : (isOwner ? "Refundable" : "Refundable by owner"), ""],
    ];
    for (const [value, className] of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (className) cell.className = className;
      row.append(cell);
    }
    const actionCell = document.createElement("td");
    const action = orderSettlementAction({
      auctionState: state.auction.state,
      cutoffTime: state.auction.cutoffTime,
      now: BigInt(Math.floor(Date.now() / 1000)),
      order,
      walletKey: state.walletKey?.toBase58(),
    });
    if (action === "cancel" || action === "claim") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "row-action";
      button.dataset.orderAction = action;
      button.dataset.orderIndex = String(order.index);
      button.textContent = action === "cancel" ? "Cancel" : state.auction.state === 1 ? "Claim" : "Refund";
      actionCell.append(button);
    } else if (action === "change-wallet") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "row-action";
      button.dataset.walletAction = "change";
      button.textContent = "Change wallet";
      button.title = "Connect the wallet that placed this order to claim it.";
      actionCell.append(button);
    } else {
      actionCell.textContent = "—";
    }
    row.append(actionCell);
    body.append(row);
  }
}

function parseUnits(value, decimals) {
  const input = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(input)) throw new RangeError("Enter a positive decimal amount.");
  const [whole, fractional = ""] = input.split(".");
  if (fractional.length > decimals) throw new RangeError(`Use at most ${decimals} decimal places.`);
  const scale = 10n ** BigInt(decimals);
  const result = BigInt(whole) * scale + BigInt(fractional.padEnd(decimals, "0") || "0");
  if (result <= 0n) throw new RangeError("Amount must be greater than zero.");
  return result;
}

function encodeU16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function encodeU64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

function encodeI64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
  return bytes;
}

function concatBytes(...arrays) {
  const length = arrays.reduce((sum, item) => sum + item.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const item of arrays) {
    joined.set(item, offset);
    offset += item.length;
  }
  return joined;
}

async function instructionDiscriminator(name) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`global:${name}`));
  return new Uint8Array(digest).slice(0, 8);
}

function findVaultAuthority(programId, auctionId) {
  return PublicKey.findProgramAddressSync([encoder.encode("vault"), auctionId.toBytes()], programId)[0];
}

async function buildTokenAccounts(ownerKey, instructions) {
  const devnet = state.devnet;
  const baseMint = new PublicKey(devnet.mints.base.address);
  const quoteMint = new PublicKey(devnet.mints.quote.address);
  const ownerBase = getAssociatedTokenAddressSync(baseMint, ownerKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const ownerQuote = getAssociatedTokenAddressSync(quoteMint, ownerKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  for (const [address, mint] of [[ownerBase, baseMint], [ownerQuote, quoteMint]]) {
    if (!await connection.getAccountInfo(address, "finalized")) {
      instructions.push(createAssociatedTokenAccountInstruction(
        ownerKey,
        address,
        ownerKey,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
    }
  }
  return { baseMint, quoteMint, ownerBase, ownerQuote };
}

function auctionVaultAddresses(programId, auction) {
  const auctionKey = new PublicKey(state.devnet.auctionAddress);
  const vaultAuthority = findVaultAuthority(programId, auctionKey);
  const baseVault = getAssociatedTokenAddressSync(
    new PublicKey(auction.baseMint), vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const quoteVault = getAssociatedTokenAddressSync(
    new PublicKey(auction.quoteMint), vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return { auctionKey, vaultAuthority, baseVault, quoteVault };
}

async function buildCreateAuctionInstruction({ auctionId, cutoffTime }) {
  const programId = new PublicKey(DEVNET_PROGRAM_ID);
  const authority = state.walletKey;
  const baseMint = new PublicKey(state.devnet.mints.base.address);
  const quoteMint = new PublicKey(state.devnet.mints.quote.address);
  const auctionIdBytes = encodeU64(auctionId);
  const [auctionKey] = PublicKey.findProgramAddressSync(
    [encoder.encode("auction"), authority.toBytes(), auctionIdBytes],
    programId,
  );
  const vaultAuthority = findVaultAuthority(programId, auctionKey);
  const baseVault = getAssociatedTokenAddressSync(baseMint, vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const quoteVault = getAssociatedTokenAddressSync(quoteMint, vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const data = concatBytes(
    await instructionDiscriminator("create_auction"),
    auctionIdBytes,
    encodeU16(AUCTION_FIRST_TICK_CENTS),
    Uint8Array.of(AUCTION_TICK_COUNT),
    encodeU16(AUCTION_REFERENCE_CENTS),
    encodeI64(cutoffTime),
  );
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: auctionKey, isSigner: false, isWritable: true },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: baseVault, isSigner: false, isWritable: true },
      { pubkey: quoteVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { instruction, auctionKey, auctionId };
}

async function buildOrderInstruction(side, limitCents, quantity) {
  const programId = new PublicKey(state.devnet.programId);
  const auction = state.auction;
  const user = state.walletKey;
  const prep = [];
  const tokens = await buildTokenAccounts(user, prep);
  const vaults = auctionVaultAddresses(programId, auction);
  const data = concatBytes(await instructionDiscriminator("place_order"), Uint8Array.of(side), encodeU16(limitCents), encodeU64(quantity));
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: vaults.auctionKey, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: tokens.baseMint, isSigner: false, isWritable: false },
      { pubkey: tokens.quoteMint, isSigner: false, isWritable: false },
      { pubkey: tokens.ownerBase, isSigner: false, isWritable: true },
      { pubkey: tokens.ownerQuote, isSigner: false, isWritable: true },
      { pubkey: vaults.vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: vaults.baseVault, isSigner: false, isWritable: true },
      { pubkey: vaults.quoteVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
  return [...prep, instruction];
}

async function buildCancelInstruction(index) {
  const programId = new PublicKey(state.devnet.programId);
  const auction = state.auction;
  const user = state.walletKey;
  const prep = [];
  const tokens = await buildTokenAccounts(user, prep);
  const vaults = auctionVaultAddresses(programId, auction);
  const data = concatBytes(await instructionDiscriminator("cancel_order"), Uint8Array.of(index));
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: vaults.auctionKey, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: tokens.baseMint, isSigner: false, isWritable: false },
      { pubkey: tokens.quoteMint, isSigner: false, isWritable: false },
      { pubkey: tokens.ownerBase, isSigner: false, isWritable: true },
      { pubkey: tokens.ownerQuote, isSigner: false, isWritable: true },
      { pubkey: vaults.vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: vaults.baseVault, isSigner: false, isWritable: true },
      { pubkey: vaults.quoteVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
  return [...prep, instruction];
}

async function buildClaimInstruction(index) {
  const programId = new PublicKey(state.devnet.programId);
  const auction = state.auction;
  const owner = state.walletKey;
  const prep = [];
  const tokens = await buildTokenAccounts(owner, prep);
  const vaults = auctionVaultAddresses(programId, auction);
  const data = concatBytes(await instructionDiscriminator("claim_order"), Uint8Array.of(index));
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: vaults.auctionKey, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: tokens.baseMint, isSigner: false, isWritable: false },
      { pubkey: tokens.quoteMint, isSigner: false, isWritable: false },
      { pubkey: tokens.ownerBase, isSigner: false, isWritable: true },
      { pubkey: tokens.ownerQuote, isSigner: false, isWritable: true },
      { pubkey: vaults.vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: vaults.baseVault, isSigner: false, isWritable: true },
      { pubkey: vaults.quoteVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
  return [...prep, instruction];
}

async function buildPermissionlessInstruction(name) {
  const programId = new PublicKey(state.devnet.programId);
  const auctionKey = new PublicKey(state.devnet.auctionAddress);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: auctionKey, isSigner: false, isWritable: true },
      { pubkey: state.walletKey, isSigner: true, isWritable: false },
    ],
    data: await instructionDiscriminator(name),
  });
}

async function submitAndFinalize(instructions, label, { button = null, reload = true, onProgress = null, review = null } = {}) {
  await requireConnectedDevnetWallet();
  if (review) {
    renderCreatorReview(review);
    if (review.action === "Fund devnet order") renderOrderReview(review);
  }
  state.busy = true;
  renderAuction();
  const actionButton = button ?? $("submit-order");
  const originalLabel = actionButton?.textContent;
  const progress = (stage, message, buttonText = message) => {
    if (onProgress) onProgress(stage, message);
    if (actionButton === $("submit-order")) renderOrderStatus(message, "progress");
    if (actionButton) actionButton.textContent = buttonText;
  };
  if (actionButton) {
    actionButton.disabled = true;
    actionButton.textContent = "Review in wallet…";
  }
  let finalized = false;
  let signature;
  try {
    let result;
    let latest;
    try {
      progress("preparation", "Preparing the Devnet transaction…", "Preparing Devnet transaction…");
      const preflight = await signAfterDevnetPreflightWithBlockhashRetry({
        getLatestBlockhash: () => connection.getLatestBlockhash(DEVNET_TRANSACTION_COMMITMENT),
        buildTransaction: (freshBlockhash) => {
          const transaction = new Transaction().add(...instructions);
          transaction.feePayer = state.walletKey;
          transaction.recentBlockhash = freshBlockhash.blockhash;
          transaction.lastValidBlockHeight = freshBlockhash.lastValidBlockHeight;
          progress("simulation", "Checking the transaction against Solana Devnet…", "Checking Devnet simulation…");
          return transaction;
        },
        simulate: (builtTransaction) => {
          const simulationTransaction = new VersionedTransaction(builtTransaction.compileMessage());
          return connection.simulateTransaction(simulationTransaction, {
            commitment: DEVNET_TRANSACTION_COMMITMENT,
          });
        },
        send: async (builtTransaction) => {
          try {
            progress("signing", `Review and sign in ${state.walletName ?? "your wallet"}. This transaction is Devnet-only.`, `Review in ${state.walletName ?? "wallet"}…`);
            const signedTransaction = await state.wallet.signTransaction(builtTransaction);
            if (!signedTransaction || typeof signedTransaction.serialize !== "function") {
              throw new Error(`${state.walletName ?? "Selected wallet"} did not return a signed Devnet transaction.`);
            }
            progress("submission", "Submitting the signed transaction to Solana Devnet…", "Submitting to Devnet…");
            const sentSignature = await connection.sendRawTransaction(signedTransaction.serialize(), {
              preflightCommitment: DEVNET_TRANSACTION_COMMITMENT,
              maxRetries: 5,
            });
            return { signature: sentSignature };
          } catch (errorValue) {
            const diagnostics = await readDevnetSendDiagnostics(errorValue, connection);
            const diagnosticError = new Error(diagnostics.message);
            diagnosticError.details = diagnostics.details;
            if (isBlockhashFailure(diagnosticError)) {
              throw new DevnetPreflightError(
                classifyDevnetProviderError(diagnosticError, { walletName: state.walletName ?? "Selected wallet" }),
                { details: diagnostics.details, retryable: true, retryReason: "submission-blockhash" },
              );
            }
            const submissionError = new Error(classifyDevnetProviderError(diagnosticError, { walletName: state.walletName ?? "Selected wallet" }));
            submissionError.details = diagnostics.details;
            throw submissionError;
          }
        },
        onRetry: (errorValue) => {
          if (errorValue?.retryReason === "submission-blockhash") {
            progress("preparation", "Devnet rejected the signed blockhash. Requesting a fresh wallet signature…", "Requesting fresh signature…");
            return;
          }
          if (errorValue?.retryable) {
            progress("preparation", "Devnet returned a temporary RPC error before signing. Retrying the simulation once…", "Retrying Devnet simulation…");
            return;
          }
          progress("preparation", "Devnet rejected the blockhash before signing. Refreshing it before another simulation…", "Refreshing Devnet blockhash…");
        },
      });
      result = preflight.result;
      latest = preflight.latestBlockhash;
    } catch (errorValue) {
      if (errorValue instanceof DevnetPreflightError) throw errorValue;
      throw new Error(classifyDevnetProviderError(errorValue, { walletName: state.walletName ?? "Selected wallet" }));
    }
    signature = typeof result === "string" ? result : result.signature;
    if (!signature) throw new Error("Wallet did not return a transaction signature.");
    progress("finalization", "Waiting for finalized Devnet confirmation…", "Waiting for finalized Devnet state…");
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, "finalized");
    if (confirmation.value.err) throw new Error("The transaction finalized with an on-chain error.");
    finalized = true;
    rememberTransaction(label, signature);
    renderProof();
    if (actionButton === $("submit-order")) {
      renderOrderReview(null);
      renderOrderStatus("Order finalized on Solana Devnet. The order table will show its current state after refresh.", "success");
    }
  } finally {
    state.busy = false;
    if (actionButton) {
      actionButton.textContent = originalLabel;
      actionButton.disabled = false;
    }
    renderAuction();
    if (finalized && reload) await loadAuction();
  }
  return signature;
}

function rememberTransaction(label, signature) {
  let recent = [];
  try { recent = JSON.parse(sessionStorage.getItem("callwindow-devnet-transactions") ?? "[]"); } catch {}
  recent.unshift({ label, signature, status: "finalized" });
  sessionStorage.setItem("callwindow-devnet-transactions", JSON.stringify(recent.slice(0, 8)));
}

async function connectWallet(walletId) {
  const wallet = getInjectedWallets().find((candidate) => candidate.id === walletId);
  if (!wallet) {
    $("wallet-status").textContent = `${walletId === "phantom" ? "Phantom" : "Solflare"} is not detected. Install it, then reload this page.`;
    renderWalletChoices();
    return;
  }
  if (!canSignDevnet(wallet.provider)) {
    $("wallet-status").textContent = `${wallet.name} does not expose signTransaction, so CallWindow cannot submit a Devnet-only transaction through it.`;
    return;
  }
  state.creatorError = null;
  state.creatorStage = null;
  if (state.walletId !== wallet.id || !state.walletKey) resetWalletForChoice(wallet.id);
  try {
    const response = await wallet.provider.connect({ onlyIfTrusted: false });
    const key = response?.publicKey ?? wallet.provider.publicKey;
    if (!key) throw new Error("The wallet did not return a public key.");
    state.wallet = wallet.provider;
    state.walletId = wallet.id;
    state.walletName = wallet.name;
    state.walletKey = new PublicKey(key.toString());
    state.walletNetwork = await readProviderNetwork(wallet.provider);
    $("wallet-status").textContent = state.walletNetwork.status === "devnet"
      ? `Connected ${compactKey(state.walletKey.toBase58())}. ${wallet.name} reports Solana Devnet.`
      : walletNetworkReason();
    closeWalletChooser();
    renderWalletChoices();
    renderWalletNetworkState();
    renderAuction();
    renderAuctionSetup();
    updateCreateEstimate();
    refreshWalletBalances();
    if (isDemoPage && activeMarketSymbol()) {
      state.distributor = await readMarketDistributorStatus(activeMarketSymbol(), state.devnet?.auctionAddress ?? null);
      renderFundingAvailability();
    }
  } catch (errorValue) {
    $("wallet-status").textContent = errorValue instanceof Error ? errorValue.message : "Wallet connection was not completed.";
  }
}

async function refreshWalletBalances() {
  if (!state.walletKey || !state.devnet) return;
  const solElement = $("room-sol");
  const baseElement = $("room-base");
  const quoteElement = $("room-quote");
  if (!solElement && !baseElement && !quoteElement) return;
  try {
    const solLamports = await connection.getBalance(state.walletKey, "finalized");
    const baseMint = new PublicKey(state.devnet.mints.base.address);
    const quoteMint = new PublicKey(state.devnet.mints.quote.address);
    const baseAta = getAssociatedTokenAddressSync(baseMint, state.walletKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const quoteAta = getAssociatedTokenAddressSync(quoteMint, state.walletKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const balances = await Promise.all([
      connection.getTokenAccountBalance(baseAta, "finalized").catch(() => ({ value: { amount: "0" } })),
      connection.getTokenAccountBalance(quoteAta, "finalized").catch(() => ({ value: { amount: "0" } })),
    ]);
    state.walletBalances = {
      sol: solLamports / LAMPORTS_PER_SOL,
      base: balances[0].value.amount,
      quote: balances[1].value.amount,
    };
    if (solElement) solElement.textContent = state.walletBalances.sol.toFixed(4) + " SOL";
    if (baseElement) baseElement.textContent = formatRawTokenAmount(state.walletBalances.base, state.devnet.mints.base.decimals);
    if (quoteElement) quoteElement.textContent = formatRawTokenAmount(state.walletBalances.quote, state.devnet.mints.quote.decimals);
  } catch (errorValue) {
    if (solElement) solElement.textContent = "unavailable";
    if (baseElement) baseElement.textContent = "unavailable";
    if (quoteElement) quoteElement.textContent = "unavailable";
    if ($("funding-status")) $("funding-status").textContent = errorValue instanceof Error ? errorValue.message : "Wallet balances unavailable.";
  }
}

async function claimTestAssets() {
  const status = $("funding-status");
  const button = $("get-test-assets");
  if (!state.walletKey) {
    status.textContent = "Connect a devnet wallet first.";
    return;
  }
  try {
    await requireConnectedDevnetWallet();
  } catch (errorValue) {
    status.textContent = errorValue instanceof Error ? errorValue.message : walletNetworkReason();
    return;
  }
  button.disabled = true;
  button.textContent = "Sending finalized distribution…";
  if ($("funding-link")) $("funding-link").hidden = true;
  try {
    const payload = { wallet: state.walletKey.toBase58() };
    if (isDemoPage && activeMarketSymbol()) payload.symbol = activeMarketSymbol();
    const setup = state.setup ?? readAuctionSetup();
    const windowOpen = state.auction?.state === 0
      && BigInt(Math.floor(Date.now() / 1000)) < state.auction.cutoffTime;
    const claimAuctionAddress = windowOpen
      ? (state.sharedAuction ? state.devnet?.auctionAddress : setup && !canShareSetup(setup) ? setup.auctionAddress : null)
      : null;
    if (claimAuctionAddress) payload.auctionAddress = claimAuctionAddress;
    const response = await fetch("/api/auction-room/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(`The test-asset distributor service returned HTTP ${response.status}. Restart the CallWindow server, then reload this room.`);
    }
    const result = await response.json();
    if (!response.ok || result.status !== "available") {
      if (result?.status === "unavailable" || result?.status === "limited") {
        if (claimAuctionAddress && !state.sharedAuction) state.creatorDistributor = result;
        else state.distributor = result;
      }
      throw new Error(result.reason ?? "Test-asset distribution was unavailable.");
    }
    status.textContent = "Finalized test assets sent to this wallet.";
    showFundingNotice(`Test assets deposited: 10 ${demoBaseName()} and 50 ${demoQuoteName()} are now available in this wallet.`);
    if ($("funding-link")) {
      $("funding-link").href = result.explorerUrl;
      $("funding-link").hidden = false;
    }
    if (result.signature) rememberTransaction("Get test assets", result.signature);
    renderProof();
    await refreshWalletBalances();
    await loadAuction();
  } catch (errorValue) {
    status.textContent = errorValue instanceof Error ? errorValue.message : "Test assets could not be distributed.";
  } finally {
    renderFundingAvailability();
  }
}

function updateEscrowEstimate() {
  const estimate = $("escrow-estimate");
  try {
    const quantity = parseUnits($("order-quantity").value, 2);
    const price = parseUnits($("order-limit").value, 2);
    if ($("order-side").value === "buy") {
      const quoteUnits = quantity * price * 100n;
      estimate.textContent = `Escrow required: ${formatQuoteUnits(quoteUnits)} ${demoQuoteName()} at this limit.`;
    } else {
      estimate.textContent = `Escrow required: ${formatShares(quantity)} ${demoBaseName()} shares.`;
    }
  } catch (errorValue) {
    estimate.textContent = errorValue instanceof Error ? errorValue.message : "Enter a valid limit and quantity.";
  }
}

function updateCreateCutoffPreview() {
  const input = $("create-cutoff");
  const preview = $("create-cutoff-preview");
  if (!input || !preview) return;
  try {
    preview.textContent = `Expected local close: ${expectedLocalCloseLabel(input.value)}. This timer starts when the auction account is created. The opening order must finalize before it reaches zero.`;
  } catch (errorValue) {
    preview.textContent = errorValue instanceof Error ? errorValue.message : "Enter an order-window duration in minutes.";
  }
}

function formatSolLamports(lamports) {
  try {
    return (Number(BigInt(lamports)) / LAMPORTS_PER_SOL).toFixed(6);
  } catch {
    return "unavailable";
  }
}

function reviewSolEstimate(funding, phase) {
  const costs = funding?.costs;
  if (!costs) return "Current rent and fee estimate is unavailable until Devnet responds.";
  if (phase === "opening") {
    return `Estimated owner token-account rent: ${formatSolLamports(costs.openingRentLamports)} SOL. Base network fee estimate: ${formatSolLamports(costs.openingFeeEstimateLamports)} SOL.`;
  }
  return `Estimated auction and vault account rent: ${formatSolLamports(costs.createRentLamports)} SOL. Base network fee estimate: ${formatSolLamports(costs.createFeeEstimateLamports)} SOL.`;
}

function openingOrderReview(setup, funding) {
  const quantity = formatShares(BigInt(setup.quantityBaseUnits));
  const price = formatDollars(setup.limitCents / 100);
  const isBuy = setup.side === 0;
  return {
    action: "Fund opening order",
    assets: isBuy ? `${demoQuoteName()} for ${demoBaseName()} test shares` : `${demoBaseName()} test shares for ${demoQuoteName()}`,
    amount: isBuy
      ? `${quantity} ${demoBaseName()} at a ${price} per-share limit. Escrow: ${formatQuoteUnits(BigInt(setup.quantityBaseUnits) * BigInt(setup.limitCents) * 100n)} ${demoQuoteName()}.`
      : `${quantity} ${demoBaseName()} escrowed at a ${price} per-share minimum.`,
    sol: reviewSolEstimate(funding, "opening"),
    cutoff: `Orders close: ${formatDevnetCutoff(setup.cutoffTime)}`,
  };
}

function creatorFundingFailure(funding, action = "this action") {
  if (funding?.status === "missing" || funding?.status === "insufficient") {
    return new Error(`The connected wallet cannot ${action}. Devnet SOL balance: ${formatSolLamports(funding.balanceLamports)} SOL. Required now: ${formatSolLamports(funding.requiredLamports)} SOL. Shortfall: ${formatSolLamports(funding.shortfallLamports)} SOL. Use the test-SOL faucet, then retry.`);
  }
  return new Error(funding?.error ?? `Devnet funding could not be checked. No ${action} transaction was built or simulated.`);
}

function creatorOwnerTokenAccounts(walletKey = state.walletKey) {
  if (!walletKey) return [];
  const mints = state.devnet?.mints ?? state.selectedMarket?.demo;
  if (!mints?.base || !mints?.quote) return [];
  return [mints.base.address, mints.quote.address].map((mint) => getAssociatedTokenAddressSync(
    new PublicKey(mint),
    walletKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ));
}

function renderCreatorFunding() {
  const status = $("create-funding-status");
  const faucet = $("create-faucet-link");
  if (!status) return;
  if (!state.walletKey || !walletCanTransact()) {
    status.hidden = true;
    if (faucet) faucet.hidden = true;
    return;
  }
  const funding = state.creatorFunding;
  status.hidden = false;
  status.dataset.state = funding?.status === "missing" || funding?.status === "insufficient" || funding?.status === "unavailable"
    ? "error"
    : "progress";
  if (!funding || funding.status === "checking") {
    status.textContent = "Checking this wallet’s finalized Devnet account and SOL balance…";
    if (faucet) faucet.hidden = true;
    return;
  }
  if (funding.status === "unavailable") {
    status.textContent = `Devnet funding check unavailable${funding.error ? `: ${funding.error}` : ". The create action is paused until the balance can be checked."}`;
    if (faucet) faucet.hidden = true;
    return;
  }
  const balance = formatSolLamports(funding.balanceLamports);
  const required = formatSolLamports(funding.requiredLamports);
  const shortfall = formatSolLamports(funding.shortfallLamports);
  if (funding.status === "missing") {
    status.textContent = `Devnet account not found. Balance: ${balance} SOL. Required: ${required} SOL. Shortfall: ${shortfall} SOL. Fund this wallet before creating a window.`;
  } else if (funding.status === "insufficient") {
    status.textContent = `Devnet SOL is insufficient. Balance: ${balance} SOL. Required: ${required} SOL. Shortfall: ${shortfall} SOL. Fund this wallet before creating a window.`;
  } else {
    const phaseLabel = funding.phase === "opening"
      ? "opening-order account rent and fees"
      : funding.phase === "create"
        ? "auction and vault account rent and create fees"
        : "account rent and create plus opening fees";
    status.textContent = `Devnet balance: ${balance} SOL. Estimated required for ${phaseLabel}: ${required} SOL. Shortfall: ${shortfall} SOL.`;
  }
  if (faucet) faucet.hidden = funding.status === "sufficient";
}

async function refreshCreatorFunding(phase = "create-and-opening") {
  if (!walletCanTransact()) {
    state.creatorFunding = null;
    renderCreatorFunding();
    return null;
  }
  const walletKey = state.walletKey.toBase58();
  state.creatorFunding = { status: "checking" };
  renderCreatorFunding();
  try {
    const funding = await readDevnetFunding({
      connection,
      walletKey: state.walletKey,
      auctionAccountSize: AUCTION_ACCOUNT_SIZE,
      tokenAccountSize: TOKEN_ACCOUNT_SIZE,
      ownerTokenAccounts: creatorOwnerTokenAccounts(),
      estimatedFeesLamports: CREATOR_ESTIMATED_FEES_LAMPORTS,
      phase,
    });
    if (state.walletKey?.toBase58() !== walletKey) return null;
    state.creatorFunding = funding;
    renderCreatorFunding();
    renderAuctionSetup();
    return funding;
  } catch (errorValue) {
    if (state.walletKey?.toBase58() !== walletKey) return null;
    state.creatorFunding = { status: "unavailable", error: errorValue instanceof Error ? errorValue.message : String(errorValue) };
    renderCreatorFunding();
    renderAuctionSetup();
    return state.creatorFunding;
  }
}

function renderAuctionSetup() {
  if (!isRoomPage || !$("create-window-form")) return;
  renderCreatorFunding();
  if (!state.setup) state.setup = readAuctionSetup();
  const setup = state.setup;
  const createButton = $("create-window");
  const finishButton = $("finish-opening-order");
  const discardButton = $("discard-creator-setup");
  const share = $("create-share-link");
  const shareUrl = $("create-share-url");
  const setupSummary = $("creator-setup-summary");
  const status = $("create-status");
  if (!setup) {
    const creatorState = creatorWindowState({ walletKey: walletCanTransact(), setup: null, error: state.creatorError });
    const fundingPending = walletCanTransact() && (!state.creatorFunding || state.creatorFunding.status === "checking");
    if (createButton) {
      createButton.disabled = creatorState.buttonDisabled || fundingPending;
      createButton.textContent = state.creatorFunding?.status === "checking"
        ? "Checking Devnet funding…"
        : creatorState.buttonText;
    }
    if (finishButton) finishButton.hidden = true;
    if (discardButton) discardButton.hidden = true;
    if (setupSummary) setupSummary.hidden = true;
    if (share) share.hidden = true;
    if (shareUrl) shareUrl.textContent = "";
    renderCreatorReview(null);
    if (status) status.textContent = state.creatorError ?? state.creatorNotice ?? (walletCanTransact()
      ? state.walletNetwork.status === "devnet" ? creatorState.status : walletNetworkReason()
      : state.walletKey ? walletNetworkReason() : creatorState.status);
    return;
  }
  const ready = canShareSetup(setup);
  const setupClosed = isCreatorSetupClosed({
    setup,
    auctionAddress: state.devnet?.auctionAddress,
    auctionState: state.auction?.state,
    cutoffTime: state.auction?.cutoffTime,
  });
  const openingEditable = canEditOpeningOrder(setup);
  const creatorState = creatorWindowState({ walletKey: walletCanTransact(), setup });
  let savedCutoffTime = null;
  try {
    savedCutoffTime = BigInt(setup.cutoffTime);
  } catch {}
  const openingState = creatorOpeningOrderState({
    walletConnected: walletCanTransact(),
    walletAddress: state.walletKey?.toBase58(),
    creatorAddress: setup.creator,
    setupAuctionAddress: setup.auctionAddress,
    loadedAuctionAddress: state.devnet?.auctionAddress,
    auctionState: state.auction?.state,
    cutoffTime: state.auction?.cutoffTime,
    savedCutoffTime,
  });
  if (createButton) {
    createButton.disabled = setupClosed ? !walletCanTransact() : creatorState.buttonDisabled;
    createButton.textContent = setupClosed ? "Start a new window" : creatorState.buttonText;
    createButton.title = setupClosed
      ? "Create a new Devnet test-asset window. The closed account remains available through its share link."
      : "";
  }
  if (finishButton) {
    finishButton.hidden = ready;
    finishButton.disabled = openingState.disabled;
  }
  if (discardButton) discardButton.hidden = ready;
  if (setupSummary) {
    setupSummary.hidden = false;
    setupSummary.textContent = ready
      ? `Resuming auction account ${compactKey(setup.auctionAddress)}. Orders close at ${formatDevnetCutoff(setup.cutoffTime)}. The cutoff is fixed on-chain from account creation. ${setupClosed ? "This account is closed and remains available for inspection." : ""}`
      : `Resuming auction account ${compactKey(setup.auctionAddress)}. Orders close at ${formatDevnetCutoff(setup.cutoffTime)}. The cutoff is fixed on-chain from account creation; opening side, limit, and quantity remain editable until the opening order is funded.`;
  }
  if (share) {
    share.hidden = !ready;
    share.href = sharedMarketUrl(window.location.origin, setup.marketSymbol ?? activeMarketSymbol(), setup.auctionAddress);
  }
  if (shareUrl) shareUrl.textContent = ready ? sharedMarketUrl(window.location.origin, setup.marketSymbol ?? activeMarketSymbol(), setup.auctionAddress) : "";
  if (status) {
    const closedSetupStatus = !state.walletKey
      ? "Connect a wallet to start a new window. The closed room remains available for inspection."
      : !walletCanTransact()
        ? walletNetworkReason()
        : "This window is closed. Open the shareable room to inspect it, or start a new window.";
    const openingStatus = openingState.reason === "wallet"
      ? "Connect the creator wallet to fund this opening order."
      : openingState.reason === "creator-wallet"
        ? "Reconnect the wallet that created this window before funding the opening order."
        : openingState.reason === "closed"
          ? "This creator window is closed or past its cutoff. Discard local setup to start a new window; on-chain account rent is not recovered."
          : null;
    status.textContent = state.creatorError ?? state.creatorNotice ?? (ready
      ? setupClosed
        ? closedSetupStatus
        : creatorState.status
      : openingStatus ?? "Auction account " + compactKey(setup.auctionAddress) + " is finalized. Review or edit the opening order, then fund it before sharing.");
  }
  if (ready) renderCreatorReview(null);
  else renderCreatorReview(openingOrderReview(setup, state.creatorFunding));
  if ($("create-side")) $("create-side").value = setup.side === 0 ? "buy" : "sell";
  if ($("create-limit")) $("create-limit").value = (setup.limitCents / 100).toFixed(2);
  if ($("create-quantity")) $("create-quantity").value = (Number(setup.quantityBaseUnits) / 100).toFixed(2);
  if ($("create-cutoff")) $("create-cutoff").value = String(setup.durationMinutes ?? Math.max(MIN_WINDOW_MINUTES, Math.round(Number(setup.durationSeconds) / 60)));
  for (const id of ["create-side", "create-limit", "create-quantity"]) {
    if ($(id)) $(id).disabled = !openingEditable;
  }
  if ($("create-cutoff")) $("create-cutoff").disabled = true;
}

async function updateCreateEstimate() {
  updateCreateCutoffPreview();
  const estimate = $("create-estimate");
  if (!estimate) return;
  try {
    const side = $("create-side").value === "buy" ? 0 : 1;
    const quantity = parseUnits($("create-quantity").value, 2);
    const limitCents = Number(parseUnits($("create-limit").value, 2));
    if (limitCents < AUCTION_FIRST_TICK_CENTS || limitCents > AUCTION_FIRST_TICK_CENTS + AUCTION_TICK_COUNT - 1) {
      throw new RangeError("Opening limit must stay inside the $19.50–$20.50 devnet grid.");
    }
    if (quantity > MAX_ORDER_BASE_UNITS) throw new RangeError("Opening quantity exceeds the 100-share program cap.");
    const requirement = orderRequirements({ side, quantityBaseUnits: quantity, limitPriceCents: limitCents });
    let solLine = "Devnet SOL rent and fees: unavailable until a wallet is connected.";
    if (walletCanTransact()) {
      if (!state.creatorFunding) await refreshCreatorFunding();
      const funding = state.creatorFunding;
      solLine = funding?.status === "sufficient"
        ? `Estimated Devnet SOL required: ${formatSolLamports(funding.requiredLamports)} SOL, including current rent and create plus opening fees.`
        : funding?.status === "checking"
          ? "Checking the connected wallet’s Devnet account and SOL balance."
          : funding?.status === "unavailable"
            ? "Devnet funding check unavailable until the RPC responds."
            : "Devnet SOL funding is below the current estimate. See the funding status beside the create action.";
    } else if (state.walletKey) {
      solLine = walletNetworkReason();
    }
    const tokenLine = side === 0
      ? "Opening buy needs " + formatQuoteUnits(requirement.quoteUnits) + " " + demoQuoteName() + " at the limit."
      : "Opening sell needs " + formatShares(requirement.baseUnits) + " " + demoBaseName() + ".";
    estimate.textContent = tokenLine + " " + solLine;
  } catch (errorValue) {
    estimate.textContent = errorValue instanceof Error ? errorValue.message : "Enter a valid opening order.";
  }
}

function creatorStatus(message, stateName = "progress") {
  const status = $("create-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = stateName;
}

function setCreatorProgress(stage, message) {
  state.creatorStage = stage;
  creatorStatus(message, "progress");
}

function creatorFailure(errorValue) {
  const detail = errorValue instanceof Error ? errorValue.message : String(errorValue ?? "The window was not created.");
  const stage = CREATOR_STAGE_LABELS[state.creatorStage] ?? "Window creation";
  const message = `${stage} failed: ${detail}`;
  state.creatorError = message;
  state.creatorDebug = errorValue?.details ?? "";
  creatorStatus(message, "error");
  renderCreatorDebug();
  return message;
}

function readOpeningOrderValues() {
  const side = $("create-side").value === "buy" ? 0 : 1;
  const quantityBaseUnits = parseUnits($("create-quantity").value, 2);
  const limitCents = Number(parseUnits($("create-limit").value, 2));
  if (!quantityBaseUnits || quantityBaseUnits < 1n || quantityBaseUnits > MAX_ORDER_BASE_UNITS) {
    throw new RangeError("Opening quantity must be between 0.01 and 100 shares.");
  }
  if (!Number.isInteger(limitCents) || limitCents < AUCTION_FIRST_TICK_CENTS || limitCents > AUCTION_FIRST_TICK_CENTS + AUCTION_TICK_COUNT - 1) {
    throw new RangeError("Opening limit must stay inside the $19.50–$20.50 devnet grid.");
  }
  return { side, quantityBaseUnits, limitCents };
}

function syncCreatorOpeningSetup() {
  const setup = state.setup;
  if (!canEditOpeningOrder(setup)) return setup;
  try {
    const values = readOpeningOrderValues();
    const next = {
      ...setup,
      side: values.side,
      quantityBaseUnits: values.quantityBaseUnits.toString(),
      limitCents: values.limitCents,
    };
    persistAuctionSetup(next);
    state.creatorError = null;
    state.creatorNotice = null;
    state.creatorStage = null;
    renderCreatorReview(openingOrderReview(next, state.creatorFunding));
    return next;
  } catch (errorValue) {
    state.creatorStage = "validation";
    state.creatorError = `Opening order validation failed: ${errorValue instanceof Error ? errorValue.message : String(errorValue)}`;
    creatorStatus(state.creatorError, "error");
    return null;
  }
}

function creatorValidationMessage(field) {
  if (field.validity.valueMissing) return "enter a value.";
  if (field.validity.rangeUnderflow) return `use ${field.min} or more.`;
  if (field.validity.rangeOverflow) return `use ${field.max} or less.`;
  if (field.validity.stepMismatch) return `use increments of ${field.step}.`;
  if (field.validity.badInput) return "enter a number.";
  return "check this value.";
}

function handleCreatorInvalid(event) {
  const field = event.target;
  if (!field?.id?.startsWith("create-") || field.validity.valid) return;
  const label = document.querySelector(`label[for="${field.id}"]`)?.textContent ?? field.name ?? "This field";
  state.creatorStage = "validation";
  state.creatorError = `${label}: ${creatorValidationMessage(field)}`;
  creatorStatus(state.creatorError, "error");
}

function clearCreatorError({ render = true } = {}) {
  if (!state.creatorError && !state.creatorNotice) return;
  state.creatorError = null;
  state.creatorNotice = null;
  state.creatorDebug = "";
  state.creatorStage = null;
  renderCreatorDebug();
  if (render) renderAuctionSetup();
}

function discardCreatorSetup() {
  const setup = state.setup ?? readAuctionSetup();
  clearAuctionSetup();
  state.creatorError = null;
  state.creatorNotice = "Local setup discarded. The on-chain auction account remains on Devnet, so its rent is not recovered. You can start a new window.";
  state.creatorDebug = "";
  state.creatorStage = null;
  renderCreatorReview(null);
  renderCreatorDebug();
  if (setup && new URLSearchParams(window.location.search).get("auction") === setup.auctionAddress) {
    history.replaceState(null, "", `/demo/?market=${encodeURIComponent(setup.marketSymbol ?? activeMarketSymbol() ?? "KALSHI")}`);
  }
  state.sharedAuction = false;
  state.liveRoom = null;
  displayUnavailableAuction(state.creatorNotice);
  renderAuctionSetup();
  loadAuction();
}

async function createAuctionWindow(event) {
  event.preventDefault();
  const form = $("create-window-form");
  const button = $("create-window");
  if (form && !form.checkValidity()) return;
  state.creatorError = null;
  state.creatorNotice = null;
  state.creatorDebug = "";
  state.creatorStage = null;
  renderCreatorReview(null);
  renderCreatorDebug();
  button.disabled = true;
  try {
    setCreatorProgress("network", `Checking ${state.walletName ?? "the selected wallet"} and Solana Devnet…`);
    await requireConnectedDevnetWallet();
    if (state.setup && !canShareSetup(state.setup)) {
      throw new Error("Finish the existing opening order before creating another window in this tab.");
    }
    setCreatorProgress("validation", "Validating the opening order…");
    const side = $("create-side").value === "buy" ? 0 : 1;
    const quantityBaseUnits = parseUnits($("create-quantity").value, 2);
    const limitCents = Number(parseUnits($("create-limit").value, 2));
    const durationMinutes = Number($("create-cutoff").value);
    if (limitCents < AUCTION_FIRST_TICK_CENTS || limitCents > AUCTION_FIRST_TICK_CENTS + AUCTION_TICK_COUNT - 1) {
      throw new RangeError("Opening limit must stay inside the $19.50–$20.50 devnet grid.");
    }
    if (quantityBaseUnits > MAX_ORDER_BASE_UNITS) throw new RangeError("Opening quantity exceeds the 100-share program cap.");
    const durationSeconds = cutoffSecondsFromMinutes(durationMinutes);
    setCreatorProgress("funding", "Checking the connected wallet’s finalized Devnet account and SOL balance…");
    const funding = await refreshCreatorFunding("create");
    if (funding?.status !== "sufficient") {
      throw creatorFundingFailure(funding, "create the auction account");
    }
    setCreatorProgress("time", "Reading finalized Solana Devnet time…");
    const chainTime = await readFinalizedDevnetTime();
    const cutoffTime = chainTime + BigInt(durationSeconds);
    const auctionId = BigInt(Date.now());
    setCreatorProgress("build", "Building the auction-account instruction…");
    const built = await buildCreateAuctionInstruction({ auctionId, cutoffTime });
    const review = {
      action: "Create auction account",
      assets: `${demoBaseName()} and ${demoQuoteName()} test assets`,
      amount: "No test tokens move in this account-creation transaction.",
      sol: reviewSolEstimate(state.creatorFunding, "create"),
      cutoff: `Orders close: ${formatDevnetCutoff(cutoffTime)}`,
    };
    renderCreatorReview(review);
    const createSignature = await submitAndFinalize([built.instruction], "Create auction window", {
      button,
      reload: false,
      onProgress: setCreatorProgress,
      review,
    });
    const setup = {
      auctionAddress: built.auctionKey.toBase58(),
      auctionId: auctionId.toString(),
      creator: state.walletKey.toBase58(),
      side,
      quantityBaseUnits: quantityBaseUnits.toString(),
      limitCents,
      durationMinutes,
      durationSeconds,
      marketSymbol: state.selectedMarket.symbol,
      mainnetMint: state.selectedMarket.mint,
      testBaseMint: state.selectedMarket.demo.base.address,
      cutoffTime: cutoffTime.toString(),
      createSignature,
    };
    persistAuctionSetup(setup);
    state.sharedAuction = true;
    state.liveRoom = { source: "shared", auctionAddress: setup.auctionAddress, status: "shared" };
    setVerifiedDevnetState(setup.auctionAddress, state.selectedMarket);
    state.creatorError = null;
    state.creatorStage = "finalization";
    await loadSharedAuction(setup.auctionAddress);
    await refreshCreatorFunding("opening");
    renderAuctionSetup();
  } catch (errorValue) {
    creatorFailure(errorValue);
    renderAuctionSetup();
  } finally {
    if (!state.setup || canShareSetup(state.setup)) {
      const fundingPending = walletCanTransact() && (!state.creatorFunding || state.creatorFunding.status === "checking");
      button.disabled = !walletCanTransact() || fundingPending;
    }
  }
}

async function finishOpeningOrder() {
  let setup = state.setup ?? readAuctionSetup();
  const status = $("create-status");
  const button = $("finish-opening-order");
  if (!setup) {
    status.textContent = "Create the auction account first.";
    return;
  }
  try {
    await requireConnectedDevnetWallet();
  } catch (errorValue) {
    status.textContent = errorValue instanceof Error ? errorValue.message : "Connect a devnet wallet first.";
    return;
  }
  if (state.walletKey.toBase58() !== setup.creator) {
    status.textContent = "Reconnect the creator wallet to finish this opening order.";
    return;
  }
  const syncedSetup = syncCreatorOpeningSetup();
  if (!syncedSetup) return;
  setup = syncedSetup;
  button.disabled = true;
  state.creatorBusy = true;
  try {
    state.creatorError = null;
    state.creatorNotice = null;
    state.creatorDebug = "";
    renderCreatorDebug();
    setCreatorProgress("state", "Refreshing the finalized Devnet auction state…");
    await refreshOpeningWindow(setup);
    setCreatorProgress("funding", "Checking current Devnet rent, fees, and wallet balance…");
    const funding = await refreshCreatorFunding("opening");
    if (funding?.status !== "sufficient") {
      throw creatorFundingFailure(funding, "fund the opening order");
    }
    setCreatorProgress("state", "Rechecking the auction state and cutoff before building…");
    await refreshOpeningWindow(setup);
    setCreatorProgress("build", "Building the funded opening-order instruction…");
    const instructions = await buildOrderInstruction(setup.side, setup.limitCents, BigInt(setup.quantityBaseUnits));
    const review = openingOrderReview(setup, state.creatorFunding);
    renderCreatorReview(review);
    setCreatorProgress("state", "Rechecking the auction state and cutoff before Devnet simulation…");
    await refreshOpeningWindow(setup);
    const signature = await submitAndFinalize(
      instructions,
      "Fund opening order",
      { button, reload: false, onProgress: setCreatorProgress, review },
    );
    persistAuctionSetup({ ...setup, openingSignature: signature });
    state.creatorError = null;
    state.creatorNotice = null;
    state.creatorDebug = "";
    state.creatorStage = "finalization";
    const url = new URL(sharedMarketUrl(window.location.origin, setup.marketSymbol ?? activeMarketSymbol(), setup.auctionAddress));
    history.replaceState(null, "", url.pathname + url.search);
    renderRoomHero();
    state.sharedAuction = true;
    await loadSharedAuction(setup.auctionAddress);
    status.textContent = "Opening order finalized. The shared window is ready.";
    renderAuctionSetup();
  } catch (errorValue) {
    let actionable = errorValue;
    if (isAuctionWindowFailure(errorValue) && errorValue?.setupUsable !== false) {
      try {
        await refreshOpeningWindow(setup);
        actionable = new Error("The auction changed while Devnet was simulating the opening order. Its refreshed state is still open. Review the order and try again.");
        actionable.details = errorValue?.details ?? "";
      } catch (refreshError) {
        actionable = refreshError;
      }
    }
    const message = creatorFailure(actionable);
    const canRetry = actionable?.setupUsable !== false;
    state.creatorError = canRetry ? `${message} You can retry the opening order.` : message;
    state.creatorDebug = actionable?.details ?? "";
    renderCreatorDebug();
    renderAuctionSetup();
    status.textContent = state.creatorError;
  } finally {
    state.creatorBusy = false;
    const windowClosed = state.auction
      && (state.auction.state !== 0
        || (typeof state.auction.cutoffTime === "bigint" && BigInt(Math.floor(Date.now() / 1_000)) >= state.auction.cutoffTime));
    button.disabled = Boolean(windowClosed) || !walletCanTransact() || state.walletKey?.toBase58() !== setup.creator;
  }
}

async function placeOrder(event) {
  event.preventDefault();
  if (!state.auction || !state.walletKey) return;
  try {
    const side = $("order-side").value === "buy" ? 0 : 1;
    const priceUnits = parseUnits($("order-limit").value, 2);
    const quantity = parseUnits($("order-quantity").value, 2);
    if (priceUnits > 10_000n) throw new RangeError("Limit price exceeds the program maximum.");
    if (quantity > MAX_ORDER_BASE_UNITS) throw new RangeError("Order quantity exceeds the 100-share program cap.");
    const priceCents = Number(priceUnits);
    const lastTick = state.auction.firstTickCents + state.auction.candidateTickCount - 1;
    if (priceCents < state.auction.firstTickCents || priceCents > lastTick) {
      throw new RangeError(`Limit must be within the auction grid (${formatDollars(state.auction.firstTickCents / 100)}–${formatDollars(lastTick / 100)}).`);
    }
    const quantityLabel = formatShares(quantity);
    const priceLabel = formatDollars(priceCents / 100);
    const review = {
      action: "Fund devnet order",
      assets: side === 0 ? `${demoQuoteName()} for ${demoBaseName()} test shares` : `${demoBaseName()} test shares for ${demoQuoteName()}`,
      amount: side === 0
        ? `${quantityLabel} ${demoBaseName()} at a ${priceLabel} per-share limit. Escrow: ${formatQuoteUnits(quantity * BigInt(priceCents) * 100n)} ${demoQuoteName()}.`
        : `${quantityLabel} ${demoBaseName()} escrowed at a ${priceLabel} per-share minimum.`,
      cutoff: `Orders close: ${formatDevnetCutoff(state.auction.cutoffTime)}`,
      note: "This is a Solana Devnet test-asset order. Phantom or Solflare may show unnamed test mints; the in-app labels and exact mint configuration remain authoritative.",
    };
    renderOrderStatus("Preparing the funded Devnet order…", "progress");
    await submitAndFinalize(await buildOrderInstruction(side, priceCents, quantity), "Place funded order", { review });
  } catch (errorValue) {
    const message = errorValue instanceof Error ? errorValue.message : "Order could not be submitted.";
    renderOrderStatus(message, "error", errorValue?.details ?? "");
    $("wallet-status").textContent = message;
  }
}

async function orderRowAction(event) {
  const walletButton = event.target.closest("[data-wallet-action]");
  if (walletButton?.dataset.walletAction === "change") {
    openWalletChooser();
    return;
  }
  const button = event.target.closest("[data-order-action]");
  if (!button || !state.walletKey) return;
  button.disabled = true;
  try {
    const index = Number(button.dataset.orderIndex);
    if (button.dataset.orderAction === "cancel") {
      await submitAndFinalize(await buildCancelInstruction(index), "Cancel and refund order");
    } else {
      await submitAndFinalize(await buildClaimInstruction(index), "Claim proceeds or refund");
    }
  } catch (errorValue) {
    $("wallet-status").textContent = errorValue instanceof Error ? errorValue.message : "Order action failed.";
    button.disabled = false;
  }
}

async function closeAuction() {
  if (!state.walletKey) return;
  try {
    await submitAndFinalize([await buildPermissionlessInstruction("close_auction")], "Close auction");
  } catch (errorValue) {
    $("wallet-status").textContent = errorValue instanceof Error ? errorValue.message : "Auction close failed.";
  }
}

async function abortAuction() {
  if (!state.walletKey) return;
  try {
    await submitAndFinalize([await buildPermissionlessInstruction("abort_auction")], "Abort auction and refund");
  } catch (errorValue) {
    $("wallet-status").textContent = errorValue instanceof Error ? errorValue.message : "Auction abort failed.";
  }
}

async function copyMint() {
  try {
    if (!state.selectedMarket) throw new Error("No verified product is selected.");
    await navigator.clipboard.writeText(state.selectedMarket.mint);
    $("copy-mint").textContent = "Copied";
    setTimeout(() => { $("copy-mint").textContent = "Copy"; }, 1400);
  } catch {
    $("market-error").hidden = false;
    $("market-error").textContent = "Clipboard access was unavailable. Select the mint address to copy it.";
  }
}

const on = (id, event, handler) => {
  const element = $(id);
  if (element) element.addEventListener(event, handler);
};

if (isDemoPage) {
  on("market-cards", "click", (event) => {
    const card = event.target.closest("button[data-symbol]");
    if (card && !card.disabled) selectMarket(card.dataset.symbol);
  });
  on("copy-mint", "click", copyMint);
}
on("connect-wallet", "click", openWalletChooser);
on("close-wallet-chooser", "click", closeWalletChooser);
on("connect-phantom", "click", () => connectWallet("phantom"));
on("connect-solflare", "click", () => connectWallet("solflare"));
on("wallet-chooser", "keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeWalletChooser();
  }
});
on("get-test-assets", "click", claimTestAssets);
on("create-window-form", "submit", createAuctionWindow);
on("discard-creator-setup", "click", discardCreatorSetup);
const creatorForm = $("create-window-form");
if (creatorForm) {
  creatorForm.addEventListener("invalid", handleCreatorInvalid, true);
  const handleCreatorInput = (event) => {
    clearCreatorError({ render: false });
    if (["create-side", "create-limit", "create-quantity"].includes(event.target?.id)) {
      syncCreatorOpeningSetup();
    }
  };
  creatorForm.addEventListener("input", handleCreatorInput);
  creatorForm.addEventListener("change", handleCreatorInput);
}
on("finish-opening-order", "click", finishOpeningOrder);
on("create-side", "change", updateCreateEstimate);
on("create-limit", "input", updateCreateEstimate);
on("create-quantity", "input", updateCreateEstimate);
on("create-cutoff", "input", updateCreateEstimate);
on("refresh-auction", "click", loadAuction);
on("order-form", "submit", placeOrder);
on("order-side", "change", updateEscrowEstimate);
on("order-limit", "input", updateEscrowEstimate);
on("order-quantity", "input", updateEscrowEstimate);
on("order-rows", "click", orderRowAction);
on("close-auction", "click", closeAuction);
on("abort-auction", "click", abortAuction);
window.addEventListener("focus", loadAuction);

if (isDemoPage) {
  loadMarket();
} else {
  loadAuction();
}
renderRoomHero();
renderWalletChoices();
renderAuctionSetup();
updateCreateCutoffPreview();
updateEscrowEstimate();
setInterval(() => {
  if (state.auction) renderAuction();
  else renderRoomCountdown();
}, 1_000);
setInterval(loadAuction, 7_000);
