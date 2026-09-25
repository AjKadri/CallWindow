import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
export const DISTRIBUTION_LOCK_PATH = process.env.CALLWINDOW_DISTRIBUTION_LOCK_PATH
  ?? DISTRIBUTION_STATE_PATH + ".lock";
export const DISTRIBUTOR_KEY_PATH = process.env.CALLWINDOW_DISTRIBUTOR_KEYFILE
  ?? path.join(ROOT, "target", "devnet", "authority.json");

export const DISTRIBUTION_LIMITS = Object.freeze({
  maxClaimsPerWallet: 2,
  maxClaimsTotal: 50,
  baseUnitsPerClaim: 1000,
  quoteUnitsPerClaim: 50_000_000,
});
export const DISTRIBUTION_LEDGER_VERSION = 3;
export const DEVNET_PROGRAM_ID = ROOM_DEVNET_PROGRAM_ID;
export const DEMO_BASE_MINT = ROOM_DEMO_BASE_MINT;
export const DEMO_QUOTE_MINT = MARKET_DEMO_QUOTE_MINT;
export const MIN_DISTRIBUTOR_LAMPORTS = 5_000_000;
const DEVNET_FAUCET_URL = "https://faucet.solana.com/";
const AUCTION_HEADER_SIZE = 216;

export function classifyDistributorFundingError(error) {
  const message = String(error?.message ?? error ?? "");
  if (/\b429\b|too many requests|rate limit/i.test(message)) {
    return "Solana Devnet RPC is rate-limited while checking distributor funding. No test-asset transaction was sent. Wait briefly, then try again.";
  }
  if (/timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return "The Solana Devnet RPC did not respond while checking distributor funding. No test-asset transaction was sent. Wait briefly, then try again.";
  }
  return "The configured test mints are currently unavailable on devnet.";
}

function isRateLimitedRpcError(error) {
  const message = String(error?.message ?? error ?? "");
  return error?.status === 429
    || error?.statusCode === 429
    || error?.code === 429
    || /\b429\b|too many requests|rate limit/i.test(message);
}

export async function retryDevnetRead(operation, { maxRetries = 2, delayMs = 250 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimitedRpcError(error) || attempt >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
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

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = BASE58_ALPHABET[0] + encoded;
  }
  return encoded || BASE58_ALPHABET[0];
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withDistributionLock(operation, {
  lockPath = DISTRIBUTION_LOCK_PATH,
  maxWaitMs = 750,
  pollMs = 25,
} = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      handle = null;
      if (error?.code !== "EEXIST") {
        throw new AuctionRoomError("The test-asset distributor is busy or its shared ledger is locked. No transaction was signed.", 503);
      }
      let stale = false;
      try {
        const record = JSON.parse(await readFile(lockPath, "utf8"));
        if (Number.isInteger(record.pid) && record.pid !== process.pid) {
          try {
            process.kill(record.pid, 0);
          } catch (probeError) {
            stale = probeError?.code === "ESRCH";
          }
        }
      } catch {
        stale = false;
      }
      if (stale) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= maxWaitMs) {
        throw new AuctionRoomError("The test-asset distributor is busy or its shared ledger is locked. No transaction was signed.", 503);
      }
      await sleep(pollMs);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function readDistributionLedger(filePath = DISTRIBUTION_STATE_PATH) {
  const stored = await readJson(filePath);
  return {
    version: DISTRIBUTION_LEDGER_VERSION,
    claims: normalizeClaims(stored),
    attempts: normalizeAttempts(stored),
  };
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
  const ledger = await readDistributionLedger(ledgerPath);
  const remainingClaims = Math.max(0, DISTRIBUTION_LIMITS.maxClaimsTotal - distributionUsage(ledger).used);
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
  if (ledger?.version != null && ledger.version !== 2 && ledger.version !== DISTRIBUTION_LEDGER_VERSION) return [];
  if (!Array.isArray(ledger?.claims)) return [];
  const legacyAuctionAddress = typeof ledger.auctionAddress === "string" ? ledger.auctionAddress : null;
  return ledger.claims.map((claim) => ({
    ...claim,
    auctionAddress: claim?.auctionAddress ?? legacyAuctionAddress,
  }));
}

export function normalizeAttempts(ledger) {
  if (ledger?.version !== DISTRIBUTION_LEDGER_VERSION || !Array.isArray(ledger?.attempts)) return [];
  return ledger.attempts.filter((attempt) => attempt && typeof attempt.wallet === "string" && attempt.signature)
    .map((attempt) => ({ ...attempt }));
}

function activeDistributionAttempts(ledger) {
  return normalizeAttempts(ledger).filter((attempt) => !["failed", "finalized"].includes(attempt.status));
}

function distributionUsage(ledger) {
  const claims = normalizeClaims(ledger);
  const attempts = activeDistributionAttempts(ledger);
  return { claims, attempts, used: claims.length + attempts.length };
}

export function globalDistributionDecision({ wallet, ledger, limits = DISTRIBUTION_LIMITS }) {
  if (!wallet) return { allowed: false, status: "invalid", reason: "Connect a devnet wallet first." };
  const { claims, attempts, used } = distributionUsage(ledger);
  const walletClaims = [...claims, ...attempts].filter((claim) => claim.wallet === wallet).length;
  if (walletClaims >= limits.maxClaimsPerWallet) {
    return {
      allowed: false,
      status: "limited",
      reason: `This wallet has reached the ${limits.maxClaimsPerWallet}-claim test-asset limit.`,
    };
  }
  if (used >= limits.maxClaimsTotal) {
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

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export async function verifyDevnetRpc(connection) {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new AuctionRoomError("The configured Solana RPC is not Devnet. No test-asset transaction was sent.", 503);
  }
  return true;
}

async function buildSignedDistribution(connection, payer, instructions) {
  await verifyDevnetRpc(connection);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: blockhash,
  }).add(...instructions);
  transaction.sign(payer);
  const serialized = transaction.serialize();
  if (!transaction.signature) throw new AuctionRoomError("The distributor could not create a signed transaction identity.", 503);
  return {
    signature: encodeBase58(transaction.signature),
    serializedTransaction: serialized.toString("base64"),
    blockhash,
    lastValidBlockHeight,
  };
}

async function persistLedger(ledger, ledgerPath = DISTRIBUTION_STATE_PATH) {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const temporaryPath = ledgerPath + ".tmp";
  await writeFile(temporaryPath, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
  await rename(temporaryPath, ledgerPath);
}

export async function reconcileDistributionAttempt(connection, attempt) {
  const statuses = await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true });
  const status = statuses?.value?.[0];
  if (status?.err) return { status: "failed", reason: JSON.stringify(status.err) };
  if (status?.confirmationStatus === "finalized") return { status: "finalized" };
  if (status) return { status: "pending" };
  if (attempt.lastValidBlockHeight == null) return { status: "unresolved" };
  const blockHeight = await connection.getBlockHeight("finalized");
  if (blockHeight > attempt.lastValidBlockHeight) return { status: "expired" };
  const resendSignature = await connection.sendRawTransaction(Buffer.from(attempt.serializedTransaction, "base64"), {
    preflightCommitment: "confirmed",
  });
  if (resendSignature !== attempt.signature) throw new Error("The Devnet RPC returned a different transaction identity while reconciling.");
  return { status: "pending" };
}

export async function broadcastDistributionAttempt(connection, attempt) {
  const broadcastSignature = await connection.sendRawTransaction(Buffer.from(attempt.serializedTransaction, "base64"), {
    preflightCommitment: "confirmed",
  });
  if (broadcastSignature !== attempt.signature) {
    throw new Error("The Devnet RPC returned a different transaction identity.");
  }
  const confirmation = await connection.confirmTransaction(
    { signature: attempt.signature, blockhash: attempt.blockhash, lastValidBlockHeight: attempt.lastValidBlockHeight },
    "finalized",
  );
  if (confirmation.value.err) throw new Error(JSON.stringify(confirmation.value.err));
  return broadcastSignature;
}

async function reconcileLedgerAttempts(connection, ledger, ledgerPath = DISTRIBUTION_STATE_PATH) {
  const active = activeDistributionAttempts(ledger);
  if (!active.length) return { ledger, unresolved: [], completedClaims: [] };
  const nextAttempts = [...normalizeAttempts(ledger)];
  const newClaims = [...normalizeClaims(ledger)];
  const completedClaims = [];
  const unresolved = [];
  for (const attempt of active) {
    let result;
    try {
      result = await reconcileDistributionAttempt(connection, attempt);
    } catch (error) {
      throw new AuctionRoomError("The distributor could not reconcile a prior test-asset transaction. No new transaction was signed.", 503);
    }
    const index = nextAttempts.findIndex((candidate) => candidate.attemptId === attempt.attemptId);
    if (result.status === "finalized") {
      nextAttempts.splice(index, 1);
      const claim = {
        wallet: attempt.wallet,
        auctionAddress: attempt.auctionAddress ?? null,
        marketSymbol: attempt.marketSymbol ?? null,
        claimedAt: new Date().toISOString(),
        signature: attempt.signature,
        baseUnits: attempt.baseUnits,
        quoteUnits: attempt.quoteUnits,
      };
      newClaims.push(claim);
      completedClaims.push(claim);
    } else if (result.status === "failed") {
      nextAttempts[index] = { ...attempt, status: "failed", error: result.reason };
    } else {
      nextAttempts[index] = { ...attempt, status: result.status === "expired" ? "unresolved" : "broadcasted" };
      unresolved.push(nextAttempts[index]);
    }
  }
  const nextLedger = { version: DISTRIBUTION_LEDGER_VERSION, claims: newClaims, attempts: nextAttempts };
  if (JSON.stringify(nextLedger) !== JSON.stringify(ledger)) await persistLedger(nextLedger, ledgerPath);
  return { ledger: nextLedger, unresolved, completedClaims };
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
  const ledger = await readDistributionLedger(ledgerPath);
  const remainingClaims = Math.max(0, DISTRIBUTION_LIMITS.maxClaimsTotal - distributionUsage(ledger).used);
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
  const ledger = await readDistributionLedger(ledgerPath);
  const usage = distributionUsage(ledger);
  const remainingClaims = Math.max(0, DISTRIBUTION_LIMITS.maxClaimsTotal - usage.used);
  const walletClaims = wallet ? [...usage.claims, ...usage.attempts].filter((claim) => claim.wallet === wallet).length : 0;
  const walletAttempt = wallet ? usage.attempts.find((attempt) => attempt.wallet === wallet) : null;
  if (walletAttempt) {
    return {
      status: "unavailable",
      scope: "market",
      reason: "A prior test-asset transaction for this wallet is still being reconciled. No second transaction will be signed.",
      maxClaimsPerWallet: DISTRIBUTION_LIMITS.maxClaimsPerWallet,
      remainingClaims,
      solFunding: "faucet",
      solFaucetUrl: DEVNET_FAUCET_URL,
    };
  }
  if (wallet && walletClaims >= DISTRIBUTION_LIMITS.maxClaimsPerWallet) {
    return {
      status: "limited",
      scope: "market",
      reason: `This wallet has reached the ${DISTRIBUTION_LIMITS.maxClaimsPerWallet}-claim test-asset limit.`,
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
    balance = await retryDevnetRead(() => connection.getBalance(authority.publicKey, "finalized"));
  } catch (error) {
    return { available: false, reason: classifyDistributorFundingError(error) };
  }
  if (balance < MIN_DISTRIBUTOR_LAMPORTS) {
    return { available: false, reason: "The test-asset distributor is out of devnet SOL for account rent and fees." };
  }
  const baseMint = new PublicKey(baseMintAddress);
  const quoteMint = new PublicKey(DEMO_QUOTE_MINT);
  try {
    const baseInfo = await retryDevnetRead(() => getMint(connection, baseMint, "finalized"));
    const quoteInfo = await retryDevnetRead(() => getMint(connection, quoteMint, "finalized"));
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
  const connection = target?.connection ?? new Connection(DEVNET_RPC, "finalized");
  return withDistributionLock(() => distributeWithLedgerLock({
    wallet,
    room,
    target,
    marketConfig,
    connection,
  }));
}

function claimResponse(claim) {
  return {
    status: "available",
    wallet: claim.wallet,
    baseUnits: claim.baseUnits,
    quoteUnits: claim.quoteUnits,
    signature: claim.signature,
    explorerUrl: "https://explorer.solana.com/tx/" + claim.signature + "?cluster=devnet",
  };
}

async function distributeWithLedgerLock({ wallet, room, target, marketConfig, connection }) {
  await verifyDevnetRpc(connection);
  const walletAddress = wallet.toBase58();
  const reconciled = await reconcileLedgerAttempts(connection, await readDistributionLedger());
  const ledger = reconciled.ledger;
  const reconciledClaim = reconciled.completedClaims.find((claim) => claim.wallet === walletAddress);
  if (reconciledClaim) return claimResponse(reconciledClaim);
  const unresolved = reconciled.unresolved.find((attempt) => attempt.wallet === walletAddress);
  if (unresolved) {
    throw new AuctionRoomError("A prior test-asset transaction for this wallet is still unresolved. CallWindow will reconcile it before signing another transaction.", 409);
  }
  const shared = Boolean(target);
  const decision = shared
    ? globalDistributionDecision({ wallet: walletAddress, ledger })
    : distributionDecision({ room, market: marketConfig, wallet: walletAddress, ledger });
  if (!decision.allowed) throw new AuctionRoomError(decision.reason, decision.status === "limited" ? 429 : 409);
  const authority = await loadAuthority();
  if (room?.distributorAuthority && room.distributorAuthority !== authority.publicKey.toBase58()) {
    throw new AuctionRoomError("The distributor authority does not match the active room.", 503);
  }
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
  const signed = await buildSignedDistribution(connection, authority, instructions);
  const attempt = {
    attemptId: `${walletAddress}:${signed.signature}`,
    wallet: walletAddress,
    auctionAddress: target?.auctionAddress ?? room?.auctionAddress ?? null,
    marketSymbol: target?.marketConfig?.symbol ?? marketConfig?.symbol ?? null,
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    baseUnits: DISTRIBUTION_LIMITS.baseUnitsPerClaim,
    quoteUnits: DISTRIBUTION_LIMITS.quoteUnitsPerClaim,
    signature: signed.signature,
    serializedTransaction: signed.serializedTransaction,
    blockhash: signed.blockhash,
    lastValidBlockHeight: signed.lastValidBlockHeight,
    status: "prepared",
    preparedAt: new Date().toISOString(),
  };
  await persistLedger({ ...ledger, attempts: [...normalizeAttempts(ledger), attempt] });

  try {
    await broadcastDistributionAttempt(connection, attempt);
    const broadcastedAttempt = { ...attempt, status: "broadcasted", broadcastedAt: new Date().toISOString() };
    await persistLedger({ ...ledger, attempts: [...normalizeAttempts(ledger), broadcastedAttempt] });
  } catch (error) {
    throw new AuctionRoomError("Test-asset distribution is unresolved. The signed Devnet transaction was retained and will be reconciled before any retry: " + error.message, 502);
  }

  const claim = {
    wallet: attempt.wallet,
    auctionAddress: attempt.auctionAddress,
    marketSymbol: attempt.marketSymbol,
    claimedAt: new Date().toISOString(),
    signature: attempt.signature,
    baseUnits: attempt.baseUnits,
    quoteUnits: attempt.quoteUnits,
  };
  const remainingAttempts = normalizeAttempts(ledger).filter((candidate) => candidate.attemptId !== attempt.attemptId);
  await persistLedger({ version: DISTRIBUTION_LEDGER_VERSION, claims: [...normalizeClaims(ledger), claim], attempts: remainingAttempts });
  return claimResponse(claim);
}
