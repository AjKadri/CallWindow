import { Buffer } from "buffer/";

globalThis.Buffer = Buffer;

const { Connection, PublicKey, Transaction, TransactionInstruction } = await import("@solana/web3.js");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} = await import("@solana/spl-token");

const KALSHI_MINT = "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua";
const DEVNET_RPC = "https://api.devnet.solana.com";
const AUCTION_STATES = ["Open", "Closed · claims available", "Halted · refunds available", "Aborted · refunds available"];
const ORDER_ACTIVE = 0;
const ORDER_CANCELLED = 1;
const MAX_ORDER_BASE_UNITS = 10_000n;
const connection = new Connection(DEVNET_RPC, "finalized");
const encoder = new TextEncoder();

const $ = (id) => document.getElementById(id);
const state = {
  market: null,
  quote: null,
  manifest: null,
  auction: null,
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
  if (mint === KALSHI_MINT) return "KALSHI";
  if (mint === state.manifest?.mints?.quote?.address) return "DEMO-USD";
  if (mint === state.manifest?.mints?.base?.address) return "DEMO-EQUITY";
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

async function loadMarket() {
  const error = $("market-error");
  clearError(error);
  try {
    const response = await fetch("/api/market", { cache: "no-store" });
    const market = await response.json();
    state.market = market;
    $("market-time").textContent = isoTime(market.observedAt);
    $("market-time").dateTime = market.observedAt ?? "";
    if (market.status !== "available") {
      $("market-name").textContent = "KALSHI record unavailable";
      $("market-description").textContent = "The official record did not pass exact-mint validation.";
      $("mark-price").textContent = "unavailable";
      $("token-price").textContent = "unavailable";
      $("token-supply").textContent = "unavailable";
      setError(error, market.reason ?? "The official PreStocks record could not be loaded.");
      return;
    }
    const record = market.record;
    if (record.mint !== KALSHI_MINT) {
      setError(error, "The returned KALSHI mint differed from the approved mint. Market fields were suppressed.");
      return;
    }
    $("market-name").textContent = record.name ?? "KALSHI PreStocks";
    $("market-description").textContent = record.description ?? "Official issuer data for the exact approved KALSHI mint.";
    $("mark-price").textContent = formatDollars(record.markPrice);
    $("token-price").textContent = formatDollars(record.tokenPrice);
    $("token-supply").textContent = formatCount(record.supply);
    $("kalshi-mint").textContent = record.mint;
  } catch (errorValue) {
    $("market-name").textContent = "KALSHI record unavailable";
    $("market-description").textContent = "The official record could not be refreshed.";
    $("mark-price").textContent = "unavailable";
    $("token-price").textContent = "unavailable";
    $("token-supply").textContent = "unavailable";
    setError(error, errorValue instanceof Error ? errorValue.message : "Market request failed.");
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
      ["Direction", quote.direction === "buy" ? "Buy KALSHI with USDC" : quote.direction === "sell" ? "Sell KALSHI for USDC" : "unavailable"],
      ["Input size", `${quote.inputAmount || "unavailable"} ${quote.inputMint ? mintName(quote.inputMint) : ""}`.trim()],
      ["Observed", isoTime(quote.observedAt)],
      ["Age", `${quoteAgeSeconds() ?? 0} seconds`],
      ["Source", quote.source ?? "Jupiter Swap API v2"],
    ]));
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
    ["Direction", quote.direction === "buy" ? "USDC into exact KALSHI mint" : "Exact KALSHI mint into USDC"],
    ["Input size", `${quote.inputAmount} ${inputToken}`],
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
  $("quote-amount-label").textContent = selling ? "KALSHI input size" : "USDC input size";
  $("quote-unit").textContent = selling ? "KALSHI" : "USDC";
  $("quote-amount").step = selling ? "0.000000001" : "0.01";
  $("quote-amount").min = selling ? "0.000000001" : "0.01";
  $("quote-amount").value = selling ? "1" : "100";
}

async function checkQuote(event) {
  event.preventDefault();
  const side = $("quote-direction").value;
  const amount = $("quote-amount").value;
  const button = $("check-quote");
  button.disabled = true;
  button.textContent = "Requesting quote…";
  $("quote-result").textContent = "Requesting a no-taker quote for the approved mint…";
  try {
    const query = new URLSearchParams({ side, amount });
    const response = await fetch(`/api/quote?${query}`, { cache: "no-store" });
    state.quote = await response.json();
    renderQuote();
  } catch (errorValue) {
    state.quote = {
      status: "unavailable",
      observedAt: new Date().toISOString(),
      reason: errorValue instanceof Error ? errorValue.message : "Quote request failed",
    };
    renderQuote();
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
  const manifest = state.manifest;
  const transactions = [...(manifest?.transactions ?? [])];
  try {
    const recent = JSON.parse(sessionStorage.getItem("callwindow-devnet-transactions") ?? "[]");
    transactions.push(...recent);
  } catch {}
  if (!transactions.length) {
    const note = document.createElement("p");
    note.textContent = "Verified proof links are listed above. Wallet actions will add their finalized signatures here.";
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
  const closeCosts = manifest?.closingCost;
  const units = manifest?.closingComputeUnits;
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

function displayUnavailableAuction(reason) {
  state.manifest = null;
  state.auction = null;
  $("auction-status").textContent = "Devnet auction unavailable";
  $("auction-summary").textContent = reason;
  $("candidate-range").textContent = "—";
  $("opening-reference").textContent = "—";
  $("clearing-price").textContent = "—";
  $("matched-quantity").textContent = "—";
  $("order-rows").innerHTML = '<tr><td colspan="6" class="empty-table">No devnet auction loaded.</td></tr>';
  $("order-form").hidden = true;
  $("auction-actions").hidden = true;
  if (reason) setError($("devnet-error"), reason);
  renderProof();
}

async function loadAuction() {
  if (state.busy) return;
  clearError($("devnet-error"));
  try {
    const response = await fetch("/api/devnet", { cache: "no-store" });
    const result = await response.json();
    if (result.status !== "available") {
      displayUnavailableAuction(result.reason ?? "No devnet auction is configured.");
      return;
    }
    const manifest = result.manifest;
    if (manifest.network !== "devnet" || !manifest.programId || !manifest.auctionAddress
      || manifest.mints?.base?.name !== "DEMO-EQUITY"
      || manifest.mints?.quote?.name !== "DEMO-USD") {
      displayUnavailableAuction("The manifest did not identify the expected devnet demo program and test mints.");
      return;
    }
    const account = await connection.getAccountInfo(new PublicKey(manifest.auctionAddress), "finalized");
    if (!account) {
      displayUnavailableAuction("The configured auction account was not found on finalized devnet state.");
      return;
    }
    const auction = decodeAuction(account.data);
    if (auction.baseMint !== manifest.mints.base.address || auction.quoteMint !== manifest.mints.quote.address) {
      displayUnavailableAuction("On-chain mint addresses did not match the labeled demo assets. The auction is suppressed.");
      return;
    }
    state.manifest = manifest;
    state.auction = auction;
    renderAuction();
    renderProof();
  } catch (errorValue) {
    displayUnavailableAuction(errorValue instanceof Error ? errorValue.message : "Devnet state request failed.");
  }
}

function renderAuction() {
  const auction = state.auction;
  if (!auction) return;
  const lastTick = auction.firstTickCents + auction.candidateTickCount - 1;
  const status = AUCTION_STATES[auction.state] ?? "Unknown state";
  const cutoff = new Date(Number(auction.cutoffTime) * 1000).toISOString().replace("T", " ").replace("Z", " UTC");
  $("auction-status").textContent = status;
  $("auction-summary").textContent = `Cutoff ${cutoff} · ${auction.orderCount} of 32 orders · prices in one-cent ticks.`;
  $("candidate-range").textContent = `${formatDollars(auction.firstTickCents / 100)}–${formatDollars(lastTick / 100)}`;
  $("opening-reference").textContent = formatDollars(auction.openingReferenceCents / 100);
  $("clearing-price").textContent = auction.clearingPriceCents > 0 ? formatDollars(auction.clearingPriceCents / 100) : "No cross";
  $("matched-quantity").textContent = formatShares(auction.matchedBase);
  $("order-form").hidden = false;
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
      [order.claimed ? (order.status === ORDER_CANCELLED ? "Cancelled" : "Claimed") : (order.status === ORDER_ACTIVE ? "Open" : "—"), ""],
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
  const manifest = state.manifest;
  const baseMint = new PublicKey(manifest.mints.base.address);
  const quoteMint = new PublicKey(manifest.mints.quote.address);
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
  const auctionKey = new PublicKey(state.manifest.auctionAddress);
  const vaultAuthority = findVaultAuthority(programId, auctionKey);
  const baseVault = getAssociatedTokenAddressSync(
    new PublicKey(auction.baseMint), vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const quoteVault = getAssociatedTokenAddressSync(
    new PublicKey(auction.quoteMint), vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return { auctionKey, vaultAuthority, baseVault, quoteVault };
}

async function buildOrderInstruction(side, limitCents, quantity) {
  const programId = new PublicKey(state.manifest.programId);
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
  const programId = new PublicKey(state.manifest.programId);
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
  const programId = new PublicKey(state.manifest.programId);
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
  const programId = new PublicKey(state.manifest.programId);
  const auctionKey = new PublicKey(state.manifest.auctionAddress);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: auctionKey, isSigner: false, isWritable: true },
      { pubkey: state.walletKey, isSigner: true, isWritable: false },
    ],
    data: await instructionDiscriminator(name),
  });
}

async function submitAndFinalize(instructions, label) {
  if (!state.wallet || !state.walletKey) throw new Error("Connect a devnet wallet first.");
  state.busy = true;
  renderAuction();
  const button = $("submit-order");
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Review in wallet…";
  let finalized = false;
  try {
    const latest = await connection.getLatestBlockhash("finalized");
    const transaction = new Transaction({
      feePayer: state.walletKey,
      recentBlockhash: latest.blockhash,
    }).add(...instructions);
    const result = await state.wallet.signAndSendTransaction(transaction);
    const signature = typeof result === "string" ? result : result.signature;
    if (!signature) throw new Error("Wallet did not return a transaction signature.");
    button.textContent = "Waiting for finalized devnet state…";
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
    button.textContent = originalLabel;
    renderAuction();
    if (finalized) await loadAuction();
  }
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
  } catch (errorValue) {
    $("wallet-status").textContent = errorValue instanceof Error ? errorValue.message : "Wallet connection was not completed.";
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
    await navigator.clipboard.writeText(KALSHI_MINT);
    $("copy-mint").textContent = "Copied";
    setTimeout(() => { $("copy-mint").textContent = "Copy"; }, 1400);
  } catch {
    $("market-error").hidden = false;
    $("market-error").textContent = "Clipboard access was unavailable. Select the mint address to copy it.";
  }
}

$("quote-direction").addEventListener("change", updateQuoteSizeControl);
$("quote-form").addEventListener("submit", checkQuote);
$("copy-mint").addEventListener("click", copyMint);
$("connect-wallet").addEventListener("click", connectWallet);
$("refresh-auction").addEventListener("click", loadAuction);
$("order-form").addEventListener("submit", placeOrder);
$("order-side").addEventListener("change", updateEscrowEstimate);
$("order-limit").addEventListener("input", updateEscrowEstimate);
$("order-quantity").addEventListener("input", updateEscrowEstimate);
$("order-rows").addEventListener("click", orderRowAction);
$("close-auction").addEventListener("click", closeAuction);
$("abort-auction").addEventListener("click", abortAuction);
window.addEventListener("focus", loadAuction);

loadMarket();
loadAuction();
updateQuoteSizeControl();
updateEscrowEstimate();
setInterval(() => {
  if (state.quote) renderQuote();
  if (state.auction) renderAuction();
}, 1_000);
setInterval(loadAuction, 7_000);
