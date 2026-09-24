import { Buffer } from "buffer/";
import { evaluateQuoteLimit } from "../src/quote/limit.mjs";
import {
  canShareSetup,
  DEMO_BASE_MINT,
  DEMO_QUOTE_MINT,
  DEVNET_PROGRAM_ID,
  MAX_ORDER_BASE_UNITS as ROOM_MAX_ORDER_BASE_UNITS,
  orderRequirements,
  previewAuction,
  sharedRoomUrl,
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
  LAMPORTS_PER_SOL,
} = await import("@solana/web3.js");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} = await import("@solana/spl-token");

const KALSHI_SYMBOL = "KALSHI";
const DEVNET_RPC = "https://api.devnet.solana.com";
const AUCTION_STATES = ["Open", "Closed · claims available", "Halted · refunds available", "Aborted · refunds available"];
const ORDER_ACTIVE = 0;
const ORDER_CANCELLED = 1;
const MAX_ORDER_BASE_UNITS = ROOM_MAX_ORDER_BASE_UNITS;
const AUCTION_ACCOUNT_SIZE = 2_168;
const TOKEN_ACCOUNT_SIZE = 165;
const AUCTION_FIRST_TICK_CENTS = 1_950;
const AUCTION_TICK_COUNT = 101;
const AUCTION_REFERENCE_CENTS = 2_000;
const CREATE_SETUP_KEY = "callwindow-auction-setup";
const connection = new Connection(DEVNET_RPC, "finalized");
const encoder = new TextEncoder();

const $ = (id) => document.getElementById(id);
const isRoomPage = document.body.dataset.page === "auction-room";
const state = {
  market: null,
  selectedMarket: null,
  quote: null,
  limitResult: null,
  proof: null,
  devnet: null,
  liveRoom: null,
  distributor: null,
  auction: null,
  preview: null,
  sharedAuction: false,
  setup: null,
  walletBalances: null,
  wallet: null,
  walletKey: null,
  busy: false,
};

function isoTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "unavailable";
  return `${new Date(value).toISOString().replace("T", " ").replace("Z", " UTC")}`;
}

function formatDollars(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unavailable";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

function formatRawTokenAmount(raw, decimals) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isInteger(decimals)) return "not reported";
  const amount = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function compactKey(value) {
  return value ? `${value.slice(0, 5)}…${value.slice(-5)}` : "unavailable";
}

function mintName(mint) {
  if (mint === state.selectedMarket?.mint) return state.selectedMarket.symbol;
  if (mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") return "USDC";
  if (mint === state.devnet?.mints?.quote?.address) return "DEMO-USD";
  if (mint === state.devnet?.mints?.base?.address) return "DEMO-EQUITY";
  return compactKey(mint);
}

function setError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.textContent = "";
  element.hidden = true;
}

function sharedAuctionAddress() {
  if (!isRoomPage) return null;
  const value = new URLSearchParams(window.location.search).get("auction");
  if (!value) return null;
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

function readAuctionSetup() {
  try {
    const setup = JSON.parse(sessionStorage.getItem(CREATE_SETUP_KEY) ?? "null");
    return setup && typeof setup.auctionAddress === "string" ? setup : null;
  } catch {
    return null;
  }
}

function persistAuctionSetup(setup) {
  state.setup = setup;
  sessionStorage.setItem(CREATE_SETUP_KEY, JSON.stringify(setup));
}

function clearAuctionSetup() {
  state.setup = null;
  sessionStorage.removeItem(CREATE_SETUP_KEY);
}

function renderMarketRecord() {
  const record = state.selectedMarket;
  if (!record) return;
  $("market-name").textContent = record.name;
  $("market-description").textContent = record.description ?? "Official issuer data for the verified PreStocks record.";
  $("market-symbol").textContent = record.symbol;
  $("mark-price").textContent = formatDollars(record.markPrice);
  $("token-price").textContent = formatDollars(record.tokenPrice);
  $("token-supply").textContent = formatCount(record.supply);
  $("selected-mint").textContent = record.mint;
  $("market-time").textContent = isoTime(state.market.observedAt);
  $("market-time").dateTime = state.market.observedAt ?? "";
  $("market-issuer-link").href = record.issuerUrl;
  $("market-disclosure-link").href = record.issuerUrl;
  $("quote-limit-issuer-link").href = record.issuerUrl;
  updateQuoteSizeControl();
}

function setMarketUnavailable(message) {
  state.selectedMarket = null;
  $("market-name").textContent = "PreStocks records unavailable";
  $("market-description").textContent = "The official product list could not be verified.";
  $("market-symbol").textContent = "unavailable";
  $("mark-price").textContent = "unavailable";
  $("token-price").textContent = "unavailable";
  $("token-supply").textContent = "unavailable";
  $("selected-mint").textContent = "unavailable";
  $("market-time").textContent = isoTime(state.market?.observedAt);
  $("market-issuer-link").removeAttribute("href");
  $("market-disclosure-link").removeAttribute("href");
  $("quote-limit-issuer-link").removeAttribute("href");
  $("quote-form").querySelector("button").disabled = true;
  resetLimitResult();
  setError($("market-error"), message);
}

function filterMarketOptions() {
  const search = $("market-search").value.trim().toLowerCase();
  for (const option of $("market-selector").options) {
    option.hidden = Boolean(search) && !option.textContent.toLowerCase().includes(search);
  }
}

function selectMarket(symbol) {
  const record = state.market?.products?.find((product) => product.symbol === symbol);
  if (!record) return;
  state.selectedMarket = record;
  $("market-selector").value = record.symbol;
  state.quote = null;
  resetLimitResult();
  clearError($("market-error"));
  renderMarketRecord();
  renderQuote();
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
    const selector = $("market-selector");
    selector.replaceChildren();
    for (const product of market.products) {
      const option = document.createElement("option");
      option.value = product.symbol;
      option.textContent = `${product.symbol} · ${product.name}`;
      selector.append(option);
    }
    selectMarket(market.products.some((product) => product.symbol === KALSHI_SYMBOL) ? KALSHI_SYMBOL : market.products[0].symbol);
    filterMarketOptions();
  } catch (errorValue) {
    state.market = { observedAt: new Date().toISOString() };
    setMarketUnavailable(errorValue instanceof Error ? errorValue.message : "Market request failed.");
  }
}

function quoteAgeSeconds() {
  if (!state.quote?.observedAt) return null;
  const timestamp = Date.parse(state.quote.observedAt);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

function renderQuote() {
  const container = $("quote-result");
  container.replaceChildren();
  const quote = state.quote;
  if (!quote) {
    const message = document.createElement("p");
    message.className = "empty-state";
    message.textContent = "Choose a direction and size to request a live read-only quote.";
    container.append(message);
    renderLimitResult();
    return;
  }
  if (quote.status !== "available") {
    const heading = document.createElement("p");
    heading.className = "quote-summary";
    heading.textContent = "Quote unavailable";
    const reason = document.createElement("p");
    reason.className = "empty-state";
    reason.textContent = quote.reason ?? "A route quote could not be obtained.";
    container.append(heading, reason, quoteDetails([
      ["Direction", quote.direction === "buy" ? `Buy ${quote.symbol ?? "selected token"} with USDC` : quote.direction === "sell" ? `Sell ${quote.symbol ?? "selected token"} for USDC` : "unavailable"],
      ["Input size", `${quote.inputAmount || "unavailable"} ${quote.inputMint ? mintName(quote.inputMint) : ""}`.trim()],
      ["Exact mint", quote.mint ?? "unavailable"],
      ["Failure type", quote.failureType ?? "unavailable"],
      ["Observed", isoTime(quote.observedAt)],
      ["Age", `${quoteAgeSeconds() ?? 0} seconds`],
      ["Source", quote.source ?? "Jupiter Swap API v2"],
    ]));
    renderLimitResult();
    return;
  }
  const inputToken = mintName(quote.inputMint);
  const outputToken = mintName(quote.outputMint);
  const heading = document.createElement("p");
  heading.className = "quote-summary";
  heading.textContent = `${quote.inputAmount} ${inputToken} → ${quote.outputAmount} ${outputToken}`;
  const feeRate = quote.fees?.totalFeeBps === null || quote.fees?.totalFeeBps === undefined
    ? "not reported"
    : `${quote.fees.totalFeeBps} bps (${(quote.fees.totalFeeBps / 100).toFixed(2)}%)`;
  const feeMint = quote.fees?.feeMint ? mintName(quote.fees.feeMint) : "not reported";
  const platformFeeDecimals = quote.fees?.platformFeeMint === quote.inputMint
    ? quote.inputDecimals
    : quote.fees?.platformFeeMint === quote.outputMint ? quote.outputDecimals : null;
  const platformFeeAmount = quote.fees?.platformFeeAmountRaw
    ? formatRawTokenAmount(quote.fees.platformFeeAmountRaw, platformFeeDecimals)
    : null;
  const platformFee = platformFeeAmount
    ? `${platformFeeAmount} ${mintName(quote.fees.platformFeeMint)}`
    : "not reported";
  const details = quoteDetails([
    ["Direction", quote.direction === "buy" ? `USDC into exact ${quote.symbol} mint` : `Exact ${quote.symbol} mint into USDC`],
    ["Input size", `${quote.inputAmount} ${inputToken}`],
    ["Output", `${quote.outputAmount} ${outputToken}`],
    ["Effective price", `${formatDollars(quote.effectivePriceUsdPerToken)} per ${quote.symbol}`],
    ["Exact mint", quote.mint ?? "unavailable"],
    ["Route", quote.route ?? "not reported"],
    ["Total fee rate", feeRate],
    ["Fee mint", feeMint],
    ["Reported platform fee rate", quote.fees?.platformFeeBps === null || quote.fees?.platformFeeBps === undefined
      ? "not reported"
      : `${quote.fees.platformFeeBps} bps (${(quote.fees.platformFeeBps / 100).toFixed(2)}%)`],
    ["Platform fee amount", platformFee],
    ["Platform fee mint", quote.fees?.platformFeeMint ? mintName(quote.fees.platformFeeMint) : "not reported"],
    ["Observed", isoTime(quote.observedAt)],
    ["Age", `${quoteAgeSeconds() ?? 0} seconds`],
    ["Source", `${quote.source} · no taker`],
  ]);
  container.append(heading, details);
  renderLimitResult();
}

function resetLimitResult() {
  state.limitResult = null;
  renderLimitResult();
}

function renderLimitResult() {
  const container = $("quote-limit-result");
  if (!container) return;
  container.replaceChildren();
  const result = state.limitResult;
  if (!result) {
    const message = document.createElement("p");
    message.className = "empty-state";
    message.textContent = "Check a fresh quote to compare it with your per-token limit.";
    container.append(message);
    return;
  }
  const message = document.createElement("p");
  message.className = result.status === "determined" ? "limit-result-message" : "empty-state";
  message.textContent = result.status === "determined"
    ? result.message
    : result.reason === "limit"
      ? "Enter a positive per-token limit to check it."
      : "No limit determination: this quote is unavailable or stale.";
  container.append(message);
}

function checkQuoteLimit() {
  state.limitResult = evaluateQuoteLimit({
    quote: state.quote,
    side: $("quote-direction").value,
    limit: $("quote-limit").value,
  });
  renderLimitResult();
}

function quoteDetails(rows) {
  const list = document.createElement("dl");
  list.className = "quote-details";
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    list.append(row);
  }
  return list;
}

function updateQuoteSizeControl() {
  const selling = $("quote-direction").value === "sell";
  const symbol = state.selectedMarket?.symbol ?? "selected token";
  $("quote-amount-label").textContent = selling ? `${symbol} input size` : "USDC input size";
  $("quote-unit").textContent = selling ? symbol : "USDC";
  $("quote-amount").step = selling ? "0.000000001" : "0.01";
  $("quote-amount").min = selling ? "0.000000001" : "0.01";
  $("quote-amount").value = selling ? "1" : "100";
  $("quote-limit-label").textContent = selling ? "Your minimum price per token" : "Your maximum price per token";
  $("quote-limit-help").textContent = selling
    ? "Compare the fresh indicative price with the minimum you would accept."
    : "Compare the fresh indicative price with the maximum you would pay.";
}

async function checkQuote(event) {
  event.preventDefault();
  const side = $("quote-direction").value;
  const amount = $("quote-amount").value;
  const market = state.selectedMarket;
  const button = $("check-quote");
  button.disabled = true;
  button.textContent = "Requesting quote…";
  $("quote-result").textContent = "Requesting a no-taker quote for the selected verified mint…";
  try {
    if (!market) throw new Error("Select a verified PreStocks product first.");
    const query = new URLSearchParams({ symbol: market.symbol, mint: market.mint, side, amount });
    const response = await fetch(`/api/quote?${query}`, { cache: "no-store" });
    state.quote = await response.json();
    renderQuote();
    checkQuoteLimit();
  } catch (errorValue) {
    state.quote = {
      status: "unavailable",
      observedAt: new Date().toISOString(),
      reason: errorValue instanceof Error ? errorValue.message : "Quote request failed",
    };
    renderQuote();
    checkQuoteLimit();
  } finally {
    button.disabled = false;
    button.textContent = "Check exact-mint quote";
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

function renderFundingAvailability() {
  if (!isRoomPage) return;
  const button = $("get-test-assets");
  const status = $("funding-status");
  if (!button || !status) return;
  const distributor = state.distributor;
  if (state.sharedAuction) {
    button.disabled = true;
    button.textContent = "Use wallet-funded test assets";
    status.textContent = "Shared windows do not change the server distributor. Bring DEMO-EQUITY, DEMO-USD, and devnet SOL from a funded test wallet.";
    return;
  }
  if (!distributor || distributor.status !== "available") {
    button.disabled = true;
    button.textContent = "Test assets unavailable";
    status.textContent = distributor?.reason ?? "No public Auction Room is open.";
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

function setVerifiedDevnetState(auctionAddress) {
  state.devnet = {
    network: "devnet",
    programId: DEVNET_PROGRAM_ID,
    auctionAddress,
    mints: {
      base: { name: "DEMO-EQUITY", address: DEMO_BASE_MINT, decimals: 2 },
      quote: { name: "DEMO-USD", address: DEMO_QUOTE_MINT, decimals: 6 },
    },
  };
}

async function loadSharedAuction(address) {
  const result = await readDevnetReference();
  state.sharedAuction = true;
  state.liveRoom = { source: "shared", auctionAddress: address, status: "shared" };
  state.distributor = result?.distributor ?? null;
  state.proof = result?.status === "available" ? result.historicalProof : null;
  const account = await connection.getAccountInfo(new PublicKey(address), "finalized");
  if (!account) throw new Error("This shared window is not available on devnet.");
  const auction = decodeAuction(account.data);
  const validation = validateSharedAuction(auction, {
    accountOwner: account.owner.toBase58(),
    programId: DEVNET_PROGRAM_ID,
  });
  if (!validation.ok) throw new Error(validation.reason);
  setVerifiedDevnetState(address);
  state.auction = auction;
  renderFundingAvailability();
  renderProof();
  renderAuction();
  refreshWalletBalances();
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
  if (state.busy) return;
  clearError($("devnet-error"));
  try {
    const hasAuctionQuery = isRoomPage && new URLSearchParams(window.location.search).has("auction");
    if (hasAuctionQuery) {
      const address = sharedAuctionAddress();
      if (!address) throw new Error("The shared auction URL is invalid.");
      await loadSharedAuction(address);
    } else {
      await loadOperatorAuction(await readDevnetReference() ?? { status: "unavailable", reason: "Devnet state request failed." });
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
    + "Cutoff " + cutoff + " · " + auction.orderCount + " of 32 orders · prices in one-cent ticks.";
  $("candidate-range").textContent = `${formatDollars(auction.firstTickCents / 100)}–${formatDollars(lastTick / 100)}`;
  $("opening-reference").textContent = formatDollars(auction.openingReferenceCents / 100);
  $("clearing-price").textContent = auction.clearingPriceCents > 0 ? formatDollars(auction.clearingPriceCents / 100) : "No cross";
  $("matched-quantity").textContent = formatShares(auction.matchedBase);
  const provisional = auction.state === 0;
  if ($("clearing-price-label")) $("clearing-price-label").textContent = provisional ? "Provisional clear" : "Final clearing price";
  if ($("matched-quantity-label")) $("matched-quantity-label").textContent = provisional ? "Provisional match" : "Final matched quantity";
  if ($("provisional-clearing-label")) $("provisional-clearing-label").textContent = provisional ? "Provisional clear" : "Final clear";
  if ($("provisional-clearing-note")) $("provisional-clearing-note").textContent = provisional ? "program tie breaks" : "on-chain close";
  if ($("provisional-matched-label")) $("provisional-matched-label").textContent = provisional ? "Provisional match" : "Final matched";
  if ($("provisional-matched-note")) $("provisional-matched-note").textContent = provisional ? "before cutoff" : "on-chain close";
  if ($("remaining-imbalance-label")) $("remaining-imbalance-label").textContent = provisional ? "Remaining imbalance" : "Final imbalance";
  if ($("remaining-imbalance-note")) $("remaining-imbalance-note").textContent = provisional ? "eligible shares" : "after close";
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
    ? "Anyone with a devnet wallet can close after the cutoff."
    : canAbort ? "Anyone can abort after 30 minutes if no claim has started." : "";
  if ($("room-next-action")) {
    $("room-next-action").textContent = windowOpen
      ? state.walletKey ? "Place a limit order" : "Connect wallet"
      : auction.state === 1 ? "Claim or refund" : auction.state === 0 ? "Close the window" : "Refund available";
  }
  if ($("room-state-note")) {
    $("room-state-note").textContent = windowOpen
      ? "Orders are funded before the cutoff. A close is permissionless after it."
      : auction.state === 1 ? "The close is finalized. Claim only an order owned by your wallet."
        : auction.state === 0 ? "The cutoff has passed. Close the window, then claim."
          : "The program state exposes refund actions where applicable.";
  }
  const orderButton = $("submit-order");
  orderButton.disabled = !state.walletKey || !windowOpen;
  orderButton.textContent = !state.walletKey
    ? "Connect wallet to continue"
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
            ? (order.filledBaseUnits > 0n ? "Filled · claimable" : "Refundable")
            : "Refundable", ""],
    ];
    for (const [value, className] of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (className) cell.className = className;
      row.append(cell);
    }
    const actionCell = document.createElement("td");
    const isOwner = state.walletKey && order.owner === state.walletKey.toBase58();
    let action = "";
    if (isOwner && !order.claimed && order.status === ORDER_ACTIVE) {
      if (state.auction.state === 0 && BigInt(Math.floor(Date.now() / 1000)) < state.auction.cutoffTime) action = "cancel";
      else if ([1, 2, 3].includes(state.auction.state)) action = "claim";
    }
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "row-action";
      button.dataset.orderAction = action;
      button.dataset.orderIndex = String(order.index);
      button.textContent = action === "cancel" ? "Cancel" : state.auction.state === 1 ? "Claim" : "Refund";
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
  const baseMint = new PublicKey(DEMO_BASE_MINT);
  const quoteMint = new PublicKey(DEMO_QUOTE_MINT);
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

async function submitAndFinalize(instructions, label, { button = null, reload = true } = {}) {
  if (!state.wallet || !state.walletKey) throw new Error("Connect a devnet wallet first.");
  state.busy = true;
  renderAuction();
  const actionButton = button ?? $("submit-order");
  const originalLabel = actionButton?.textContent;
  if (actionButton) {
    actionButton.disabled = true;
    actionButton.textContent = "Review in wallet…";
  }
  let finalized = false;
  let signature;
  try {
    const latest = await connection.getLatestBlockhash("finalized");
    const transaction = new Transaction({
      feePayer: state.walletKey,
      recentBlockhash: latest.blockhash,
    }).add(...instructions);
    const result = await state.wallet.signAndSendTransaction(transaction);
    signature = typeof result === "string" ? result : result.signature;
    if (!signature) throw new Error("Wallet did not return a transaction signature.");
    if (actionButton) actionButton.textContent = "Waiting for finalized devnet state…";
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, "finalized");
    if (confirmation.value.err) throw new Error("The transaction finalized with an on-chain error.");
    finalized = true;
    rememberTransaction(label, signature);
    renderProof();
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

async function connectWallet() {
  const provider = window.phantom?.solana ?? window.solana;
  if (!provider?.connect) {
    $("wallet-status").textContent = "No Solana wallet provider was found. Install or enable Phantom, then connect on devnet.";
    return;
  }
  try {
    const response = await provider.connect({ onlyIfTrusted: false });
    const key = response?.publicKey ?? provider.publicKey;
    if (!key) throw new Error("The wallet did not return a public key.");
    state.wallet = provider;
    state.walletKey = new PublicKey(key.toString());
    $("wallet-status").textContent = `Connected ${compactKey(state.walletKey.toBase58())}. The app sends transactions to Solana devnet.`;
    $("connect-wallet").textContent = "Connected · change wallet";
    renderAuction();
    renderAuctionSetup();
    updateCreateEstimate();
    refreshWalletBalances();
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
  button.disabled = true;
  button.textContent = "Sending finalized distribution…";
  if ($("funding-link")) $("funding-link").hidden = true;
  try {
    const response = await fetch("/api/auction-room/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: state.walletKey.toBase58() }),
    });
    const result = await response.json();
    if (!response.ok || result.status !== "available") throw new Error(result.reason ?? "Test-asset distribution was unavailable.");
    status.textContent = "Finalized test assets sent to this wallet.";
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
      estimate.textContent = `Escrow required: ${formatQuoteUnits(quoteUnits)} DEMO-USD at this limit.`;
    } else {
      estimate.textContent = `Escrow required: ${formatShares(quantity)} DEMO-EQUITY shares.`;
    }
  } catch (errorValue) {
    estimate.textContent = errorValue instanceof Error ? errorValue.message : "Enter a valid limit and quantity.";
  }
}

function renderAuctionSetup() {
  if (!isRoomPage || !$("create-window-form")) return;
  if (!state.setup) state.setup = readAuctionSetup();
  const setup = state.setup;
  const createButton = $("create-window");
  const finishButton = $("finish-opening-order");
  const share = $("create-share-link");
  const shareUrl = $("create-share-url");
  const status = $("create-status");
  if (!setup) {
    if (createButton) createButton.disabled = !state.walletKey;
    if (finishButton) finishButton.hidden = true;
    if (share) share.hidden = true;
    if (shareUrl) shareUrl.textContent = "";
    if (status && !state.walletKey) status.textContent = "Connect a devnet wallet to create a window account.";
    return;
  }
  const ready = canShareSetup(setup);
  if (createButton) {
    createButton.disabled = true;
    createButton.textContent = ready ? "Opening order finalized" : "Window account created";
  }
  if (finishButton) {
    finishButton.hidden = ready;
    finishButton.disabled = !state.walletKey || state.walletKey.toBase58() !== setup.creator;
  }
  if (share) {
    share.hidden = !ready;
    share.href = sharedRoomUrl(window.location.origin, setup.auctionAddress);
  }
  if (shareUrl) shareUrl.textContent = ready ? sharedRoomUrl(window.location.origin, setup.auctionAddress) : "";
  if (status) {
    status.textContent = ready
      ? "Opening order finalized. This window can be shared."
      : "Auction account " + compactKey(setup.auctionAddress) + " is finalized. Finish the opening order before sharing.";
  }
  if ($("create-side")) $("create-side").value = setup.side === 0 ? "buy" : "sell";
  if ($("create-limit")) $("create-limit").value = (setup.limitCents / 100).toFixed(2);
  if ($("create-quantity")) $("create-quantity").value = (Number(setup.quantityBaseUnits) / 100).toFixed(2);
  if ($("create-cutoff")) $("create-cutoff").value = String(setup.durationSeconds);
  for (const id of ["create-side", "create-limit", "create-quantity", "create-cutoff"]) {
    if ($(id)) $(id).disabled = true;
  }
}

async function updateCreateEstimate() {
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
    if (state.walletKey) {
      const baseMint = new PublicKey(DEMO_BASE_MINT);
      const quoteMint = new PublicKey(DEMO_QUOTE_MINT);
      const ownerBase = getAssociatedTokenAddressSync(baseMint, state.walletKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const ownerQuote = getAssociatedTokenAddressSync(quoteMint, state.walletKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const missingOwnerAtas = (await Promise.all([
        connection.getAccountInfo(ownerBase, "finalized"),
        connection.getAccountInfo(ownerQuote, "finalized"),
      ])).filter((account) => !account).length;
      const [auctionRent, tokenRent] = await Promise.all([
        connection.getMinimumBalanceForRentExemption(AUCTION_ACCOUNT_SIZE, "finalized"),
        connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE, "finalized"),
      ]);
      const rent = auctionRent + tokenRent * (2 + missingOwnerAtas);
      const baseFees = 10_000;
      solLine = "Expected account rent ≈ " + (rent / LAMPORTS_PER_SOL).toFixed(6)
        + " SOL. Base network fees ≈ " + (baseFees / LAMPORTS_PER_SOL).toFixed(6)
        + " SOL for the create and opening-order transactions, before wallet-specific changes.";
    }
    const tokenLine = side === 0
      ? "Opening buy needs " + formatQuoteUnits(requirement.quoteUnits) + " DEMO-USD at the limit."
      : "Opening sell needs " + formatShares(requirement.baseUnits) + " DEMO-EQUITY.";
    estimate.textContent = tokenLine + " " + solLine;
  } catch (errorValue) {
    estimate.textContent = errorValue instanceof Error ? errorValue.message : "Enter a valid opening order.";
  }
}

async function createAuctionWindow(event) {
  event.preventDefault();
  const button = $("create-window");
  const status = $("create-status");
  if (!state.walletKey) {
    status.textContent = "Connect a devnet wallet before creating a window.";
    return;
  }
  if (state.setup && !canShareSetup(state.setup)) {
    status.textContent = "Finish the existing opening order before creating another window in this tab.";
    return;
  }
  button.disabled = true;
  try {
    const side = $("create-side").value === "buy" ? 0 : 1;
    const quantityBaseUnits = parseUnits($("create-quantity").value, 2);
    const limitCents = Number(parseUnits($("create-limit").value, 2));
    const durationSeconds = Number($("create-cutoff").value);
    if (limitCents < AUCTION_FIRST_TICK_CENTS || limitCents > AUCTION_FIRST_TICK_CENTS + AUCTION_TICK_COUNT - 1) {
      throw new RangeError("Opening limit must stay inside the $19.50–$20.50 devnet grid.");
    }
    if (quantityBaseUnits > MAX_ORDER_BASE_UNITS) throw new RangeError("Opening quantity exceeds the 100-share program cap.");
    if (!Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3600) {
      throw new RangeError("Choose a cutoff between 10 seconds and one hour.");
    }
    status.textContent = "Review the auction-account transaction in your wallet.";
    const slot = await connection.getSlot("finalized");
    const chainTime = await connection.getBlockTime(slot);
    if (!Number.isSafeInteger(chainTime)) throw new Error("Devnet time was unavailable. Try again.");
    const cutoffTime = BigInt(chainTime + durationSeconds);
    const auctionId = BigInt(Date.now());
    const built = await buildCreateAuctionInstruction({ auctionId, cutoffTime });
    const createSignature = await submitAndFinalize([built.instruction], "Create auction window", { button, reload: false });
    const setup = {
      auctionAddress: built.auctionKey.toBase58(),
      auctionId: auctionId.toString(),
      creator: state.walletKey.toBase58(),
      side,
      quantityBaseUnits: quantityBaseUnits.toString(),
      limitCents,
      durationSeconds,
      cutoffTime: cutoffTime.toString(),
      createSignature,
    };
    persistAuctionSetup(setup);
    state.sharedAuction = true;
    state.liveRoom = { source: "shared", auctionAddress: setup.auctionAddress, status: "shared" };
    setVerifiedDevnetState(setup.auctionAddress);
    status.textContent = "Auction account finalized. Now fund the opening order before sharing.";
    await loadSharedAuction(setup.auctionAddress);
    renderAuctionSetup();
  } catch (errorValue) {
    status.textContent = errorValue instanceof Error ? errorValue.message : "Auction creation was not completed.";
    renderAuctionSetup();
  } finally {
    if (!state.setup || canShareSetup(state.setup)) button.disabled = false;
  }
}

async function finishOpeningOrder() {
  const setup = state.setup ?? readAuctionSetup();
  const status = $("create-status");
  const button = $("finish-opening-order");
  if (!setup) {
    status.textContent = "Create the auction account first.";
    return;
  }
  if (!state.walletKey || state.walletKey.toBase58() !== setup.creator) {
    status.textContent = "Reconnect the creator wallet to finish this opening order.";
    return;
  }
  button.disabled = true;
  try {
    if (!state.auction || state.devnet?.auctionAddress !== setup.auctionAddress) {
      await loadSharedAuction(setup.auctionAddress);
    }
    if (state.auction?.state !== 0) throw new Error("The created window is no longer open for an opening order.");
    status.textContent = "Review the funded opening order in your wallet.";
    const signature = await submitAndFinalize(
      await buildOrderInstruction(setup.side, setup.limitCents, BigInt(setup.quantityBaseUnits)),
      "Fund opening order",
      { button, reload: false },
    );
    persistAuctionSetup({ ...setup, openingSignature: signature });
    const url = new URL(sharedRoomUrl(window.location.origin, setup.auctionAddress));
    history.replaceState(null, "", url.pathname + url.search);
    state.sharedAuction = true;
    await loadSharedAuction(setup.auctionAddress);
    status.textContent = "Opening order finalized. The shared window is ready.";
    renderAuctionSetup();
  } catch (errorValue) {
    status.textContent = errorValue instanceof Error ? errorValue.message : "Opening order was not finalized. You can retry it.";
    renderAuctionSetup();
  } finally {
    button.disabled = false;
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
    await submitAndFinalize(await buildOrderInstruction(side, priceCents, quantity), "Place funded order");
  } catch (errorValue) {
    $("wallet-status").textContent = errorValue instanceof Error ? errorValue.message : "Order could not be submitted.";
  }
}

async function orderRowAction(event) {
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

if (!isRoomPage) {
  on("market-search", "input", filterMarketOptions);
  on("market-selector", "change", (event) => selectMarket(event.target.value));
  on("quote-direction", "change", updateQuoteSizeControl);
  on("quote-direction", "change", resetLimitResult);
  on("quote-amount", "input", resetLimitResult);
  on("quote-limit", "input", resetLimitResult);
  on("quote-form", "submit", checkQuote);
  on("copy-mint", "click", copyMint);
}
on("connect-wallet", "click", connectWallet);
on("get-test-assets", "click", claimTestAssets);
on("create-window-form", "submit", createAuctionWindow);
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

if (!isRoomPage) {
  loadMarket();
  updateQuoteSizeControl();
}
loadAuction();
renderAuctionSetup();
updateEscrowEstimate();
setInterval(() => {
  if (state.quote) renderQuote();
  if (state.limitResult) checkQuoteLimit();
  if (state.auction) renderAuction();
  else renderRoomCountdown();
}, 1_000);
setInterval(loadAuction, 7_000);
