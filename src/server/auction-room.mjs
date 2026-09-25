import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  DEMO_BASE_MINT as ROOM_DEMO_BASE_MINT,
  DEMO_QUOTE_MINT as ROOM_DEMO_QUOTE_MINT,
  DEVNET_PROGRAM_ID as ROOM_DEVNET_PROGRAM_ID,
  MAX_CANDIDATE_TICKS,
  MAX_ORDERS,
  MAX_PRICE_CENTS,
  MIN_CANDIDATE_TICKS,
} from "../auction/room.mjs";
import { getVerifiedDemoRecord } from "./market.mjs";
import { DEMO_QUOTE_MINT as MARKET_DEMO_QUOTE_MINT, getDemoMarketConfig } from "../market/demo.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEVNET_RPC = process.env.CALLWINDOW_DEVNET_RPC ?? "https://api.devnet.solana.com";
export const ROOM_PATH = process.env.CALLWINDOW_ROOM_PATH ?? path.join(ROOT, "target", "devnet", "auction-room.json");
export const MARKET_ROOMS_PATH = process.env.CALLWINDOW_MARKET_ROOMS_PATH ?? path.join(ROOT, "target", "devnet", "market-rooms.json");
export const DISTRIBUTION_STATE_PATH = process.env.CALLWINDOW_DISTRIBUTION_STATE_PATH
  ?? path.join(ROOT, "target", "devnet", "auction-room-distributions.json");
export const DISTRIBUTOR_KEY_PATH = process.env.CALLWINDOW_DISTRIBUTOR_KEYFILE
  ?? path.join(ROOT, "target", "devnet", "authority.json");

export const DISTRIBUTION_LIMITS = Object.freeze({
  maxClaimsPerWallet: 1,
  maxClaimsTotal: 20,
  baseUnitsPerClaim: 1000,
  quoteUnitsPerClaim: 50_000_000,
});
export const DEVNET_PROGRAM_ID = ROOM_DEVNET_PROGRAM_ID;
export const DEMO_BASE_MINT = ROOM_DEMO_BASE_MINT;
export const DEMO_QUOTE_MINT = MARKET_DEMO_QUOTE_MINT;
export const MIN_DISTRIBUTOR_LAMPORTS = 5_000_000;
const DEVNET_FAUCET_URL = "https://faucet.solana.com/";
const AUCTION_HEADER_SIZE = 216;

export function classifyDistributorFundingError(error) {
  const message = String(error?.message ?? error ?? "");
  if (/\b429\b|too many requests|rate limit/i.test(message)) {
    return "Solana Devnet RPC is rate-limited while checking the distributor's test mints. Wait briefly, then reload the Demo.";
  }
  if (/timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return "The Solana Devnet RPC did not respond while checking the distributor's test mints. Wait briefly, then reload the Demo.";
  }
  return "The configured test mints are currently unavailable on devnet.";
}

export class AuctionRoomError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AuctionRoomError";
    this.statusCode = statusCode;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function validateLiveAuctionRoom(room) {
  return Boolean(
    room
    && room.network === "devnet"
    && room.status === "open"
    && typeof room.programId === "string"
    && typeof room.auctionAddress === "string"
    && room.mints?.base?.name === "DEMO-EQUITY"
    && room.mints?.base?.address === DEMO_BASE_MINT
    && room.mints?.base?.decimals === 2
    && room.mints?.quote?.name === "DEMO-USD"
    && room.mints?.quote?.address === DEMO_QUOTE_MINT
    && room.mints?.quote?.decimals === 6,
  );
}

export async function readLiveAuctionRoom() {
  const room = await readJson(ROOM_PATH);
  if (!validateLiveAuctionRoom(room)) return null;
  const hasPassedCutoff = room.cutoffTime && Date.parse(room.cutoffTime) <= Date.now();
  return { ...room, status: hasPassedCutoff ? "closed" : "open" };
}

export async function readConfiguredMarketAuction(symbol, manifestPath = MARKET_ROOMS_PATH) {
  const marketConfig = getDemoMarketConfig(symbol);
  if (!marketConfig) return null;
  const manifest = await readJson(manifestPath);
  const room = manifest?.markets?.[marketConfig.symbol] ?? null;
  if (!room || room.network !== "devnet" || room.programId !== DEVNET_PROGRAM_ID || typeof room.auctionAddress !== "string") return null;
  if (room.mints?.base?.address !== marketConfig.testMint || room.mints?.quote?.address !== marketConfig.quoteMint) return null;
  return { ...room, symbol: marketConfig.symbol };
}

export async function getDistributorStatus(
  room,
  keyPath = DISTRIBUTOR_KEY_PATH,
  now = Date.now(),
  ledgerPath = DISTRIBUTION_STATE_PATH,
) {
  if (!room) {
    return {
      status: "unavailable",
      reason: "No public Auction Room is open.",
      solFunding: "faucet",
      solFaucetUrl: "https://faucet.solana.com/",
    };
  }
  if (!existsSync(keyPath)) {
    return {
      status: "unavailable",
      reason: "The test-asset distributor is not configured on this server.",
      solFunding: "faucet",
      solFaucetUrl: "https://faucet.solana.com/",
    };
  }
  if (room.status !== "open" || (room.cutoffTime && Date.parse(room.cutoffTime) <= now)) {
    return {
      status: "unavailable",
      reason: "This window has passed its cutoff. Start the next window for fresh test assets.",
      solFunding: "faucet",
      solFaucetUrl: "https://faucet.solana.com/",
    };
  }
  const claims = normalizeClaims(await readJson(ledgerPath));
  const remainingClaims = Math.max(0, DISTRIBUTION_LIMITS.maxClaimsTotal - claims.length);
  if (remainingClaims === 0) {
    return {
      status: "unavailable",
      reason: "The global test-asset distribution cap has been reached.",
      maxClaimsPerWallet: DISTRIBUTION_LIMITS.maxClaimsPerWallet,
      remainingClaims: 0,
      solFunding: "faucet",
      solFaucetUrl: "https://faucet.solana.com/",
    };
  }
  return {
    status: "available",
    maxClaimsPerWallet: DISTRIBUTION_LIMITS.maxClaimsPerWallet,
    remainingClaims,
    baseUnitsPerClaim: DISTRIBUTION_LIMITS.baseUnitsPerClaim,
    quoteUnitsPerClaim: DISTRIBUTION_LIMITS.quoteUnitsPerClaim,
    solFunding: "faucet",
    solFaucetUrl: "https://faucet.solana.com/",
  };
}

export function normalizeClaims(ledger) {
  if (!Array.isArray(ledger?.claims)) return [];
  const legacyAuctionAddress = typeof ledger.auctionAddress === "string" ? ledger.auctionAddress : null;
  return ledger.claims.map((claim) => ({
    ...claim,
    auctionAddress: claim?.auctionAddress ?? legacyAuctionAddress,
  }));
}

export function globalDistributionDecision({ wallet, ledger, limits = DISTRIBUTION_LIMITS }) {
  if (!wallet) return { allowed: false, status: "invalid", reason: "Connect a devnet wallet first." };
  const claims = normalizeClaims(ledger);
  if (claims.some((claim) => claim.wallet === wallet)) {
    return { allowed: false, status: "limited", reason: "This wallet has already claimed test assets." };
  }
  if (claims.length >= limits.maxClaimsTotal) {
    return { allowed: false, status: "limited", reason: "The global test-asset distribution cap has been reached." };
  }
  return { allowed: true, status: "available" };
}

export function distributionDecision({ room, market, wallet, ledger, limits = DISTRIBUTION_LIMITS, now = Date.now() }) {
  if (!room && !market) return { allowed: false, status: "unavailable", reason: "No public Auction Room is open." };
  if (!wallet) return { allowed: false, status: "invalid", reason: "Connect a devnet wallet first." };
  if (!market && room.cutoffTime && Date.parse(room.cutoffTime) <= now) {
    return { allowed: false, status: "unavailable", reason: "This window has passed its cutoff. Start the next window for fresh test assets." };
  }
  return globalDistributionDecision({ wallet, ledger, limits });
}

function readSharedAuctionHeader(data) {
  if (!data || data.length < AUCTION_HEADER_SIZE) {
    throw new AuctionRoomError("The shared auction account is incomplete.", 409);
  }
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
  const header = {
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
  header.orderStorageLength = view.getUint32(offset, true);
  return header;
}

export function validateSharedAuctionRecord(
  record,
  { accountOwner, programId = DEVNET_PROGRAM_ID, now = Math.floor(Date.now() / 1000) } = {},
) {
  const errors = [];
  if (accountOwner !== programId) errors.push("The shared auction account is not owned by the CallWindow devnet program.");
  if (record?.baseMint !== DEMO_BASE_MINT || record?.quoteMint !== DEMO_QUOTE_MINT) {
    errors.push("The shared auction does not use the exact DEMO-EQUITY and DEMO-USD devnet mints.");
  }
  if (!Number.isInteger(record?.firstTickCents) || !Number.isInteger(record?.candidateTickCount)) {
    errors.push("The shared auction grid is unavailable.");
  } else {
    const lastTick = record.firstTickCents + record.candidateTickCount - 1;
    if (record.candidateTickCount < MIN_CANDIDATE_TICKS || record.candidateTickCount > MAX_CANDIDATE_TICKS) {
      errors.push("The shared auction exceeds the 101-tick program bound.");
    }
    if (record.firstTickCents < 1 || lastTick > MAX_PRICE_CENTS) {
      errors.push("The shared auction price grid is outside the deployed program bounds.");
    }
    if (record.openingReferenceCents < record.firstTickCents || record.openingReferenceCents > lastTick) {
      errors.push("The shared auction opening reference is outside the grid.");
    }
  }
  if (!Number.isInteger(record?.orderCount) || record.orderCount < 0 || record.orderCount > MAX_ORDERS) {
    errors.push("The shared auction exceeds the 32-order program bound.");
  }
  if (record?.orderStorageLength !== 32) errors.push("The shared auction order storage does not match the deployed bound.");
  if (record?.state !== 0) errors.push("This shared window is no longer open for test-asset claims.");
  if (typeof record?.cutoffTime !== "bigint" || record.cutoffTime <= BigInt(now)) {
    errors.push("This shared window has passed its cutoff.");
  }
  return { ok: errors.length === 0, errors, reason: errors[0] ?? null };
}

export async function validateSharedAuctionForDistribution(
  auctionAddress,
  { connectionFactory = (rpc) => new Connection(rpc, "finalized"), now = Math.floor(Date.now() / 1000) } = {},
) {
  let publicKey;
  try {
    publicKey = new PublicKey(auctionAddress);
  } catch {
    throw new AuctionRoomError("The shared auction URL is invalid.", 409);
  }
  const connection = connectionFactory(DEVNET_RPC);
  let account;
  try {
    account = await connection.getAccountInfo(publicKey, "finalized");
  } catch (error) {
    throw new AuctionRoomError("The shared auction state is currently unavailable on devnet.", 503);
  }
  if (!account) throw new AuctionRoomError("This shared window is not available on devnet.", 409);
  let record;
  try {
    record = readSharedAuctionHeader(account.data);
  } catch (error) {
    if (error instanceof AuctionRoomError) throw error;
    throw new AuctionRoomError("The shared auction account could not be decoded.", 409);
  }
  const validation = validateSharedAuctionRecord(record, {
    accountOwner: account.owner.toBase58(),
    now,
  });
  if (!validation.ok) throw new AuctionRoomError(validation.reason, 409);
  return { auctionAddress: publicKey.toBase58(), connection, record };
}

export function validateMarketAuctionRecord(
  record,
  { accountOwner, marketConfig, programId = DEVNET_PROGRAM_ID, now = Math.floor(Date.now() / 1000), requireOpen = true } = {},
) {
  const errors = [];
  if (!marketConfig) errors.push("The selected PreStocks market is not supported by the CallWindow test-asset allowlist.");
  if (accountOwner !== programId) errors.push("The market auction account is not owned by the CallWindow devnet program.");
  if (marketConfig && record?.baseMint !== marketConfig.testMint) errors.push(`The auction does not use the exact ${marketConfig.testName} devnet test mint.`);
  if (marketConfig && record?.quoteMint !== marketConfig.quoteMint) errors.push("The auction does not use the exact DEMO-USD devnet test mint.");
  if (!Number.isInteger(record?.firstTickCents) || !Number.isInteger(record?.candidateTickCount)) {
    errors.push("The market auction grid is unavailable.");
  } else {
    const lastTick = record.firstTickCents + record.candidateTickCount - 1;
    if (record.candidateTickCount < MIN_CANDIDATE_TICKS || record.candidateTickCount > MAX_CANDIDATE_TICKS) errors.push("The market auction exceeds the 101-tick program bound.");
    if (record.firstTickCents < 1 || lastTick > MAX_PRICE_CENTS) errors.push("The market auction price grid is outside the deployed bounds.");
    if (record.openingReferenceCents < record.firstTickCents || record.openingReferenceCents > lastTick) errors.push("The market auction opening reference is outside the grid.");
  }
  if (!Number.isInteger(record?.orderCount) || record.orderCount < 0 || record.orderCount > MAX_ORDERS) errors.push("The market auction exceeds the 32-order program bound.");
  if (record?.orderStorageLength !== 32) errors.push("The market auction order storage does not match the deployed bound.");
  if (requireOpen && record?.state !== 0) errors.push("This market window is no longer open for test-asset claims.");
  if (requireOpen && (typeof record?.cutoffTime !== "bigint" || record.cutoffTime <= BigInt(now))) errors.push("This market window has passed its cutoff.");
  return { ok: errors.length === 0, errors, reason: errors[0] ?? null };
}

export async function validateMarketAuctionForDistribution(
  auctionAddress,
  symbol,
  {
    connectionFactory = (rpc) => new Connection(rpc, "finalized"),
    marketFetchImpl = fetch,
    now = Math.floor(Date.now() / 1000),
    requireOpen = true,
  } = {},
) {
  const marketConfig = getDemoMarketConfig(symbol);
  if (!marketConfig) throw new AuctionRoomError("The selected PreStocks product is not supported for a Devnet auction.", 409);
  const verified = await getVerifiedDemoRecord({ symbol: marketConfig.symbol, mint: marketConfig.mainnetMint }, marketFetchImpl);
  if (verified.status !== "available") throw new AuctionRoomError(verified.reason, 503);
  let publicKey;
  try { publicKey = new PublicKey(auctionAddress); } catch { throw new AuctionRoomError("The market auction URL is invalid.", 409); }
  const connection = connectionFactory(DEVNET_RPC);
  let account;
  try { account = await connection.getAccountInfo(publicKey, "finalized"); } catch { throw new AuctionRoomError("The market auction state is currently unavailable on devnet.", 503); }
  if (!account) throw new AuctionRoomError("This market auction is not available on devnet.", 409);
  let record;
  try { record = readSharedAuctionHeader(account.data); } catch (error) {
    if (error instanceof AuctionRoomError) throw error;
    throw new AuctionRoomError("The market auction account could not be decoded.", 409);
  }
  const validation = validateMarketAuctionRecord(record, { accountOwner: account.owner.toBase58(), marketConfig, now, requireOpen });
  if (!validation.ok) throw new AuctionRoomError(validation.reason, 409);
  return { auctionAddress: publicKey.toBase58(), connection, record, marketConfig, official: verified.record };
}

async function loadAuthority(keyPath = DISTRIBUTOR_KEY_PATH) {
  const raw = await readJson(keyPath);
  if (!Array.isArray(raw)) throw new AuctionRoomError("The server-side distributor key is unavailable.", 503);
  try {
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch {
    throw new AuctionRoomError("The server-side distributor key is invalid.", 503);
  }
}

async function sendFinalized(connection, payer, instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: blockhash,
  }).add(...instructions);
  transaction.sign(payer);
  let signature;
  try {
    signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: "confirmed" });
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "finalized",
    );
    if (confirmation.value.err) throw new Error(JSON.stringify(confirmation.value.err));
  } catch (error) {
    throw new AuctionRoomError("Test-asset distribution failed: " + error.message, 502);
  }
  return signature;
}

async function persistLedger(ledger) {
  await mkdir(path.dirname(DISTRIBUTION_STATE_PATH), { recursive: true });
  const temporaryPath = DISTRIBUTION_STATE_PATH + ".tmp";
  await writeFile(temporaryPath, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
  await rename(temporaryPath, DISTRIBUTION_STATE_PATH);
}

let distributionQueue = Promise.resolve();

export function claimTestAssets(walletAddress, auctionAddress = null, symbol = null) {
  const operation = distributionQueue.then(() => distributeTestAssets(walletAddress, auctionAddress, symbol));
  distributionQueue = operation.catch(() => {});
  return operation;
}

export async function getSharedDistributorStatus(
  auctionAddress,
  {
    symbol = null,
    keyPath = DISTRIBUTOR_KEY_PATH,
    ledgerPath = DISTRIBUTION_STATE_PATH,
    connectionFactory = (rpc) => new Connection(rpc, "finalized"),
    now = Date.now(),
    marketFetchImpl = fetch,
  } = {},
) {
  if (!auctionAddress) return { status: "unavailable", reason: "A shared auction address is required." };
  if (!existsSync(keyPath)) {
    return { status: "unavailable", reason: "The test-asset distributor is not configured on this server.", solFunding: "faucet", solFaucetUrl: DEVNET_FAUCET_URL };
  }
  let target;
  try {
    target = symbol
      ? await validateMarketAuctionForDistribution(auctionAddress, symbol, { connectionFactory, now: Math.floor(now / 1000), marketFetchImpl })
      : await validateSharedAuctionForDistribution(auctionAddress, { connectionFactory, now: Math.floor(now / 1000) });
  } catch (error) {
    return {
      status: "unavailable",
      reason: error.message || "The shared auction state is currently unavailable on devnet.",
      solFunding: "faucet",
      solFaucetUrl: DEVNET_FAUCET_URL,
    };
  }
  const claims = normalizeClaims(await readJson(ledgerPath));
  const remainingClaims = Math.max(0, DISTRIBUTION_LIMITS.maxClaimsTotal - claims.length);
  if (remainingClaims === 0) {
    return {
      status: "unavailable",
      reason: "The global test-asset distribution cap has been reached.",
      maxClaimsPerWallet: DISTRIBUTION_LIMITS.maxClaimsPerWallet,
      remainingClaims: 0,
      solFunding: "faucet",
      solFaucetUrl: DEVNET_FAUCET_URL,
    };
  }
  let authority;
  try {
    authority = await loadAuthority(keyPath);
  } catch (error) {
    return { status: "unavailable", reason: error.message, solFunding: "faucet", solFaucetUrl: DEVNET_FAUCET_URL };
  }
  const funding = await distributorFundingStatus(target.connection, authority, target.marketConfig?.testMint ?? DEMO_BASE_MINT);
  if (!funding.available) return { status: "unavailable", reason: funding.reason, solFunding: "faucet", solFaucetUrl: DEVNET_FAUCET_URL };
  return {
    status: "available",
    scope: "window",
    maxClaimsPerWallet: DISTRIBUTION_LIMITS.maxClaimsPerWallet,
    remainingClaims,
    baseUnitsPerClaim: DISTRIBUTION_LIMITS.baseUnitsPerClaim,
    quoteUnitsPerClaim: DISTRIBUTION_LIMITS.quoteUnitsPerClaim,
    solFunding: "faucet",
    solFaucetUrl: DEVNET_FAUCET_URL,
  };
}

export async function getMarketDistributorStatus(
  symbol,
  {
    wallet = null,
    keyPath = DISTRIBUTOR_KEY_PATH,
    ledgerPath = DISTRIBUTION_STATE_PATH,
    connectionFactory = (rpc) => new Connection(rpc, "finalized"),
    marketFetchImpl = fetch,
  } = {},
) {
  const marketConfig = getDemoMarketConfig(symbol);
  if (!marketConfig) {
    return { status: "unavailable", reason: "The selected PreStocks product is not supported for Devnet test assets." };
  }
  if (!existsSync(keyPath)) {
    return { status: "unavailable", reason: "The test-asset distributor is not configured on this server.", solFunding: "faucet", solFaucetUrl: DEVNET_FAUCET_URL };
  }
  try {
    const verified = await getVerifiedDemoRecord({ symbol: marketConfig.symbol, mint: marketConfig.mainnetMint }, marketFetchImpl);
    if (verified.status !== "available") return { status: "unavailable", reason: verified.reason, solFunding: "faucet", solFaucetUrl: DEVNET_FAUCET_URL };
  } catch (error) {
    return { status: "unavailable", scope: "market", reason: error.message || "The selected official PreStocks record is unavailable.", solFunding: "faucet", solFaucetUrl: DEVNET_FAUCET_URL };
  }
  const claims = normalizeClaims(await readJson(ledgerPath));
  const remainingClaims = Math.max(0, DISTRIBUTION_LIMITS.maxClaimsTotal - claims.length);
  if (wallet && claims.some((claim) => claim.wallet === wallet)) {
    return {
      status: "limited",
      scope: "market",
      reason: "This wallet has already claimed test assets. The global distributor allows one claim per wallet.",
      maxClaimsPerWallet: DISTRIBUTION_LIMITS.maxClaimsPerWallet,
      remainingClaims,
      baseUnitsPerClaim: DISTRIBUTION_LIMITS.baseUnitsPerClaim,
      quoteUnitsPerClaim: DISTRIBUTION_LIMITS.quoteUnitsPerClaim,
      solFunding: "faucet",
      solFaucetUrl: DEVNET_FAUCET_URL,
    };
  }
  if (remainingClaims === 0) {
    return {
      status: "unavailable",
      scope: "market",
      reason: "The global test-asset distribution cap has been reached.",
      maxClaimsPerWallet: DISTRIBUTION_LIMITS.maxClaimsPerWallet,
      remainingClaims: 0,
      solFunding: "faucet",
      solFaucetUrl: DEVNET_FAUCET_URL,
    };
  }
  let authority;
  try {
    authority = await loadAuthority(keyPath);
  } catch (error) {
    return { status: "unavailable", scope: "market", reason: error.message, solFunding: "faucet", solFaucetUrl: DEVNET_FAUCET_URL };
  }
  const connection = connectionFactory(DEVNET_RPC);
  const funding = await distributorFundingStatus(connection, authority, marketConfig.testMint);
  if (!funding.available) return { status: "unavailable", scope: "market", reason: funding.reason, solFunding: "faucet", solFaucetUrl: DEVNET_FAUCET_URL };
  return {
    status: "available",
    scope: "market",
    symbol: marketConfig.symbol,
    maxClaimsPerWallet: DISTRIBUTION_LIMITS.maxClaimsPerWallet,
    remainingClaims,
    baseUnitsPerClaim: DISTRIBUTION_LIMITS.baseUnitsPerClaim,
    quoteUnitsPerClaim: DISTRIBUTION_LIMITS.quoteUnitsPerClaim,
    solFunding: "faucet",
    solFaucetUrl: DEVNET_FAUCET_URL,
  };
}

async function distributorFundingStatus(connection, authority, baseMintAddress = DEMO_BASE_MINT) {
  let balance;
  try {
    balance = await connection.getBalance(authority.publicKey, "finalized");
  } catch (error) {
    return { available: false, reason: classifyDistributorFundingError(error) };
  }
  if (balance < MIN_DISTRIBUTOR_LAMPORTS) {
    return { available: false, reason: "The test-asset distributor is out of devnet SOL for account rent and fees." };
  }
  const baseMint = new PublicKey(baseMintAddress);
  const quoteMint = new PublicKey(DEMO_QUOTE_MINT);
  try {
    const [baseInfo, quoteInfo] = await Promise.all([
      getMint(connection, baseMint, "finalized"),
      getMint(connection, quoteMint, "finalized"),
    ]);
    if (
      baseInfo.decimals !== 2
      || quoteInfo.decimals !== 6
      || baseInfo.mintAuthority?.toBase58() !== authority.publicKey.toBase58()
      || quoteInfo.mintAuthority?.toBase58() !== authority.publicKey.toBase58()
    ) {
      return { available: false, reason: "The configured test mints do not match the distributor authority or decimals." };
    }
  } catch (error) {
    return { available: false, reason: classifyDistributorFundingError(error) };
  }
  return { available: true };
}

async function distributeTestAssets(walletAddress, auctionAddress = null, symbol = null) {
  let wallet;
  try {
    wallet = new PublicKey(walletAddress);
  } catch {
    throw new AuctionRoomError("Provide a valid Solana wallet address.");
  }
  const shared = Boolean(auctionAddress);
  const marketConfig = !shared && symbol ? getDemoMarketConfig(symbol) : null;
  const target = shared
    ? symbol
      ? await validateMarketAuctionForDistribution(auctionAddress, symbol)
      : await validateSharedAuctionForDistribution(auctionAddress)
    : null;
  if (!shared && symbol) {
    if (!marketConfig) throw new AuctionRoomError("The selected PreStocks product is not supported for Devnet test assets.", 409);
    const verified = await getVerifiedDemoRecord({ symbol: marketConfig.symbol, mint: marketConfig.mainnetMint });
    if (verified.status !== "available") throw new AuctionRoomError(verified.reason, 503);
  }
  const room = shared ? null : await readLiveAuctionRoom();
  const storedLedger = (await readJson(DISTRIBUTION_STATE_PATH)) ?? { version: 1, claims: [] };
  const ledger = { version: 1, claims: normalizeClaims(storedLedger) };
  const decision = shared
    ? globalDistributionDecision({ wallet: wallet.toBase58(), ledger })
    : distributionDecision({ room, market: marketConfig, wallet: wallet.toBase58(), ledger });
  if (!decision.allowed) throw new AuctionRoomError(decision.reason, decision.status === "limited" ? 429 : 409);
  const authority = await loadAuthority();
  if (room?.distributorAuthority && room.distributorAuthority !== authority.publicKey.toBase58()) {
    throw new AuctionRoomError("The distributor authority does not match the active room.", 503);
  }
  const connection = target?.connection ?? new Connection(DEVNET_RPC, "finalized");
  const baseMintAddress = target?.marketConfig?.testMint ?? marketConfig?.testMint ?? DEMO_BASE_MINT;
  const funding = await distributorFundingStatus(connection, authority, baseMintAddress);
  if (!funding.available) throw new AuctionRoomError(funding.reason, 503);
  const baseMint = new PublicKey(baseMintAddress);
  const quoteMint = new PublicKey(DEMO_QUOTE_MINT);
  const baseAta = getAssociatedTokenAddressSync(baseMint, wallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const quoteAta = getAssociatedTokenAddressSync(quoteMint, wallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const instructions = [];
  for (const [ata, mint] of [[baseAta, baseMint], [quoteAta, quoteMint]]) {
    if (!(await connection.getAccountInfo(ata, "finalized"))) {
      instructions.push(createAssociatedTokenAccountInstruction(
        authority.publicKey,
        ata,
        wallet,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
    }
  }
  instructions.push(
    createMintToInstruction(baseMint, baseAta, authority.publicKey, DISTRIBUTION_LIMITS.baseUnitsPerClaim),
    createMintToInstruction(quoteMint, quoteAta, authority.publicKey, DISTRIBUTION_LIMITS.quoteUnitsPerClaim),
  );
  const signature = await sendFinalized(connection, authority, instructions);
  const claim = {
    wallet: wallet.toBase58(),
    auctionAddress: target?.auctionAddress ?? room?.auctionAddress ?? null,
    marketSymbol: target?.marketConfig?.symbol ?? marketConfig?.symbol ?? null,
    claimedAt: new Date().toISOString(),
    signature,
    baseUnits: DISTRIBUTION_LIMITS.baseUnitsPerClaim,
    quoteUnits: DISTRIBUTION_LIMITS.quoteUnitsPerClaim,
  };
  await persistLedger({ version: 1, claims: [...ledger.claims, claim] });
  return {
    status: "available",
    wallet: wallet.toBase58(),
    baseUnits: claim.baseUnits,
    quoteUnits: claim.quoteUnits,
    signature,
    explorerUrl: "https://explorer.solana.com/tx/" + signature + "?cluster=devnet",
  };
}
