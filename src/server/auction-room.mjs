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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEVNET_RPC = process.env.CALLWINDOW_DEVNET_RPC ?? "https://api.devnet.solana.com";
export const ROOM_PATH = process.env.CALLWINDOW_ROOM_PATH ?? path.join(ROOT, "target", "devnet", "auction-room.json");
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
const DEMO_BASE_MINT = "B6ZoEr92PB58bN1MgTXwjZHBUxCZ895ERVdhFJtSQFcP";
const DEMO_QUOTE_MINT = "7gLQ8vdtYTxbHa4YK9gjjsVe49WiKeH6pi2pV8us8zd4";

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
  const ledger = await readJson(ledgerPath);
  const claims = ledger?.auctionAddress === room.auctionAddress && Array.isArray(ledger.claims)
    ? ledger.claims
    : [];
  const remainingClaims = Math.max(0, DISTRIBUTION_LIMITS.maxClaimsTotal - claims.length);
  if (remainingClaims === 0) {
    return {
      status: "unavailable",
      reason: "The test-asset distribution cap for this window has been reached.",
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

export function distributionDecision({ room, wallet, ledger, limits = DISTRIBUTION_LIMITS, now = Date.now() }) {
  if (!room) return { allowed: false, status: "unavailable", reason: "No public Auction Room is open." };
  if (!wallet) return { allowed: false, status: "invalid", reason: "Connect a devnet wallet first." };
  if (room.cutoffTime && Date.parse(room.cutoffTime) <= now) {
    return { allowed: false, status: "unavailable", reason: "This window has passed its cutoff. Start the next window for fresh test assets." };
  }
  const claims = Array.isArray(ledger?.claims) ? ledger.claims : [];
  if (claims.some((claim) => claim.wallet === wallet)) {
    return { allowed: false, status: "limited", reason: "This wallet has already claimed test assets for the current window." };
  }
  if (claims.length >= limits.maxClaimsTotal) {
    return { allowed: false, status: "limited", reason: "The test-asset distribution cap for this window has been reached." };
  }
  return { allowed: true, status: "available" };
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

export function claimTestAssets(walletAddress) {
  const operation = distributionQueue.then(() => distributeTestAssets(walletAddress));
  distributionQueue = operation.catch(() => {});
  return operation;
}

async function distributeTestAssets(walletAddress) {
  let wallet;
  try {
    wallet = new PublicKey(walletAddress);
  } catch {
    throw new AuctionRoomError("Provide a valid Solana wallet address.");
  }
  const room = await readLiveAuctionRoom();
  const storedLedger = (await readJson(DISTRIBUTION_STATE_PATH)) ?? { claims: [] };
  const ledger = room && storedLedger.auctionAddress !== room.auctionAddress
    ? { auctionAddress: room.auctionAddress, claims: [] }
    : storedLedger;
  const decision = distributionDecision({
    room,
    wallet: wallet.toBase58(),
    ledger,
  });
  if (!decision.allowed) throw new AuctionRoomError(decision.reason, decision.status === "limited" ? 429 : 409);
  const authority = await loadAuthority();
  if (room.distributorAuthority && room.distributorAuthority !== authority.publicKey.toBase58()) {
    throw new AuctionRoomError("The distributor authority does not match the active room.", 503);
  }
  const connection = new Connection(DEVNET_RPC, "confirmed");
  const baseMint = new PublicKey(room.mints.base.address);
  const quoteMint = new PublicKey(room.mints.quote.address);
  const [baseInfo, quoteInfo] = await Promise.all([getMint(connection, baseMint, "finalized"), getMint(connection, quoteMint, "finalized")]);
  if (
    baseInfo.decimals !== room.mints.base.decimals
    || quoteInfo.decimals !== room.mints.quote.decimals
    || baseInfo.mintAuthority?.toBase58() !== authority.publicKey.toBase58()
    || quoteInfo.mintAuthority?.toBase58() !== authority.publicKey.toBase58()
  ) {
    throw new AuctionRoomError("The configured test mints do not match the distributor authority or decimals.", 503);
  }
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
    claimedAt: new Date().toISOString(),
    signature,
    baseUnits: DISTRIBUTION_LIMITS.baseUnitsPerClaim,
    quoteUnits: DISTRIBUTION_LIMITS.quoteUnitsPerClaim,
  };
  await persistLedger({ auctionAddress: room.auctionAddress, claims: [...ledger.claims, claim] });
  return {
    status: "available",
    wallet: wallet.toBase58(),
    baseUnits: claim.baseUnits,
    quoteUnits: claim.quoteUnits,
    signature,
    explorerUrl: "https://explorer.solana.com/tx/" + signature + "?cluster=devnet",
  };
}
