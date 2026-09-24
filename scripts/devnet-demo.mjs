import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLUSTER_NAME = process.env.CALLWINDOW_CLUSTER ?? "devnet";
const CLUSTERS = {
  devnet: { rpc: "https://api.devnet.solana.com", keyDirectory: "devnet" },
  localnet: { rpc: "http://127.0.0.1:8899", keyDirectory: "localnet" },
};
const cluster = CLUSTERS[CLUSTER_NAME];
if (!cluster) throw new Error("CALLWINDOW_CLUSTER must be devnet or localnet.");
const CLUSTER_RPC = cluster.rpc;
const CUTOFF_SECONDS = Number(process.env.CALLWINDOW_CUTOFF_SECONDS ?? 90);
if (!Number.isSafeInteger(CUTOFF_SECONDS) || CUTOFF_SECONDS < 10) {
  throw new Error("CALLWINDOW_CUTOFF_SECONDS must be an integer of at least 10 seconds.");
}
const PROGRAM_ID_PATH = path.join(ROOT, "target/deploy/callwindow_escrow-keypair.json");
const DEPLOY_PATH = path.join(ROOT, "target/deploy/callwindow_escrow.so");
const KEY_DIR = path.join(ROOT, "target", cluster.keyDirectory);
const PROGRAM_BIN = path.join(ROOT, ".tools/solana/active_release/bin/solana");
const MAX_ORDERS = 32;
const MAX_CANDIDATE_TICKS = 101;
const PROGRAM_BUFFER_METADATA_BYTES = 37;
const PROGRAM_DATA_METADATA_BYTES = 45;
const PROGRAM_ACCOUNT_BYTES = 36;
const UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const TOKEN_MINT_ACCOUNT_BYTES = 82;
const TOKEN_ACCOUNT_BYTES = 165;
// This build's local deployment measured 1,445,000 lamports in loader-write fees for 288,048 bytes.
const PROGRAM_WRITE_BYTES_PER_TRANSACTION = 1_000;
const BASE_TRANSACTION_FEE_LAMPORTS = 5_000;
// Measured in the complete local flow after subtracting the rent for its created accounts.
const AUTHORITY_DEMO_FEE_ESTIMATE_LAMPORTS = 80_000;
// Holds room for network fee variation and small deployment-account differences.
const AUTHORITY_FUNDING_RESERVE_LAMPORTS = 30_000_000;
const FUNDING_ROUNDING_LAMPORTS = 10_000_000;
const ROLE_WALLET_RESERVE_LAMPORTS = 10_000_000;
const BUYER_OBSERVED_FEES_LAMPORTS = 50_000;
const SELLER_OBSERVED_FEES_LAMPORTS = 40_000;
const FIRST_TICK_CENTS = 1_950;
const OPENING_REFERENCE_CENTS = 2_000;
const CANDIDATE_TICK_COUNT = 101;
const BASE_MINT_DECIMALS = 2;
const QUOTE_MINT_DECIMALS = 6;
const RESUMED_BASE_MINT = process.env.CALLWINDOW_BASE_MINT ?? null;
const RESUMED_QUOTE_MINT = process.env.CALLWINDOW_QUOTE_MINT ?? null;
const RESUMED_BASE_MINT_TRANSACTION = process.env.CALLWINDOW_BASE_MINT_TX ?? null;
const RESUMED_QUOTE_MINT_TRANSACTION = process.env.CALLWINDOW_QUOTE_MINT_TX ?? null;
const RESUMED_BASE_ATA_TRANSACTION = process.env.CALLWINDOW_BASE_ATA_TX ?? null;
const DEPLOYMENT_TRANSACTION = process.env.CALLWINDOW_DEPLOYMENT_SIGNATURE ?? null;
const ORDER_ACTIVE = 0;
const ORDER_CANCELLED = 1;
const AUCTION_CLOSED = 1;
const RPC_MIN_INTERVAL_MS = CLUSTER_NAME === "devnet"
  ? Number(process.env.CALLWINDOW_RPC_MIN_INTERVAL_MS ?? 650)
  : 0;
const RPC_MAX_RETRIES = 3;
if (!Number.isSafeInteger(RPC_MIN_INTERVAL_MS) || RPC_MIN_INTERVAL_MS < 0) {
  throw new Error("CALLWINDOW_RPC_MIN_INTERVAL_MS must be a non-negative integer.");
}

let nextRpcRequestAt = 0;
let rpcQueue = Promise.resolve();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(response, fallbackMilliseconds) {
  const header = response.headers.get("retry-after");
  if (!header) return fallbackMilliseconds;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(250, seconds * 1_000));
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(30_000, Math.max(250, date - Date.now()));
  return fallbackMilliseconds;
}

async function pacedFetch(url, options) {
  const run = async () => {
    let lastError;
    for (let attempt = 0; attempt <= RPC_MAX_RETRIES; attempt += 1) {
      const waitMilliseconds = Math.max(0, nextRpcRequestAt - Date.now());
      if (waitMilliseconds > 0) await sleep(waitMilliseconds);
      try {
        const response = await fetch(url, options);
        if (response.status === 429 && attempt < RPC_MAX_RETRIES) {
          const retryMilliseconds = retryAfterMilliseconds(response, 1_000 * (2 ** attempt));
          await response.text();
          nextRpcRequestAt = Date.now() + retryMilliseconds;
          continue;
        }
        nextRpcRequestAt = Date.now() + RPC_MIN_INTERVAL_MS;
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= RPC_MAX_RETRIES) throw error;
        const retryMilliseconds = 1_000 * (2 ** attempt);
        nextRpcRequestAt = Date.now() + retryMilliseconds;
      }
    }
    throw lastError ?? new Error("RPC request failed after bounded retries.");
  };
  const result = rpcQueue.then(run, run);
  rpcQueue = result.catch(() => undefined);
  return result;
}

const connection = new Connection(CLUSTER_RPC, {
  commitment: "finalized",
  fetch: pacedFetch,
  disableRetryOnRateLimit: true,
});

function invariant(value, message) {
  if (!value) throw new Error(message);
}

async function loadOrCreateKeypair(name) {
  const filePath = path.join(KEY_DIR, `${name}.json`);
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(filePath, "utf8"))));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const keypair = Keypair.generate();
  await writeFile(filePath, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, { mode: 0o600, flag: "wx" });
  return keypair;
}

async function ensureClusterFunds(keypair, requiredLamports) {
  let balance = await connection.getBalance(keypair.publicKey, "finalized");
  if (balance >= requiredLamports) return balance;
  if (CLUSTER_NAME === "devnet") {
    throw new Error(`Devnet wallet ${keypair.publicKey.toBase58()} has ${balance} lamports; ${requiredLamports} are required. No public devnet faucet request was sent.`);
  }
  let attempts = 0;
  const maxAttempts = Math.ceil(requiredLamports / (2 * LAMPORTS_PER_SOL)) + 3;
  while (balance < requiredLamports && attempts < maxAttempts) {
    attempts += 1;
    const amount = Math.min(2 * LAMPORTS_PER_SOL, requiredLamports - balance);
    const signature = await connection.requestAirdrop(keypair.publicKey, amount);
    const result = await connection.confirmTransaction(signature, "finalized");
    invariant(!result.value.err, `${CLUSTER_NAME} faucet transfer failed for ${keypair.publicKey.toBase58()}`);
    balance = await connection.getBalance(keypair.publicKey, "finalized");
  }
  invariant(balance >= requiredLamports, `${CLUSTER_NAME} wallet ${keypair.publicKey.toBase58()} has ${balance} lamports; ${requiredLamports} lamports are required.`);
  return balance;
}

function ceilToMultiple(value, multiple) {
  return Math.ceil(value / multiple) * multiple;
}

async function inspectExistingDeployment(programId, expectedUpgradeAuthority) {
  const programAccount = await connection.getAccountInfo(programId, "finalized");
  if (!programAccount) {
    return {
      mode: "fresh",
      programAccountLamports: 0,
      programDataAddress: null,
      programDataLamports: 0,
    };
  }
  invariant(programAccount.executable, "An account already exists at the program ID but is not executable.");
  invariant(programAccount.owner.equals(UPGRADEABLE_LOADER_ID), "The existing program is not owned by Solana's upgradeable loader.");
  invariant(programAccount.data.length >= PROGRAM_ACCOUNT_BYTES, "The existing upgradeable program account data is incomplete.");
  const programDataAddress = new PublicKey(programAccount.data.subarray(4, 36));
  const programDataAccount = await connection.getAccountInfo(programDataAddress, "finalized");
  invariant(programDataAccount, "The existing ProgramData account is missing at finalized commitment.");
  invariant(programDataAccount.owner.equals(UPGRADEABLE_LOADER_ID), "The existing ProgramData account is not owned by Solana's upgradeable loader.");
  invariant(programDataAccount.data.length >= PROGRAM_DATA_METADATA_BYTES, "The existing ProgramData account data is incomplete.");
  invariant(programDataAccount.data.readUInt32LE(0) === 3, "The existing program has an invalid ProgramData state.");
  invariant(programDataAccount.data[12] === 1, "The existing program is immutable and cannot be upgraded by the demo authority.");
  const upgradeAuthority = new PublicKey(programDataAccount.data.subarray(13, 45));
  invariant(upgradeAuthority.equals(expectedUpgradeAuthority), "The existing program's upgrade authority does not match the demo authority.");
  return {
    mode: "upgrade",
    programAccountLamports: programAccount.lamports,
    programDataAddress,
    programDataLamports: programDataAccount.lamports,
  };
}

async function calculateFundingEstimate(programLength, existingDeployment) {
  const programBufferBytes = programLength + PROGRAM_BUFFER_METADATA_BYTES;
  const programDataBytes = programLength + PROGRAM_DATA_METADATA_BYTES;
  const programRentLamports = await connection.getMinimumBalanceForRentExemption(PROGRAM_ACCOUNT_BYTES, "finalized");
  const bufferRentLamports = await connection.getMinimumBalanceForRentExemption(programBufferBytes, "finalized");
  const programDataRentLamports = await connection.getMinimumBalanceForRentExemption(programDataBytes, "finalized");
  const auctionRentLamports = await connection.getMinimumBalanceForRentExemption(8 + 204 + 4 + MAX_ORDERS * 61, "finalized");
  const mintRentLamports = await connection.getMinimumBalanceForRentExemption(TOKEN_MINT_ACCOUNT_BYTES, "finalized");
  const tokenAccountRentLamports = await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES, "finalized");
  const programRentIncreaseLamports = Math.max(0, programRentLamports - existingDeployment.programAccountLamports);
  const programDataRentIncreaseLamports = Math.max(0, programDataRentLamports - existingDeployment.programDataLamports);
  const deploymentPersistentRentIncreaseLamports = programRentIncreaseLamports + programDataRentIncreaseLamports;
  const deploymentPeakRentLamports = existingDeployment.mode === "fresh"
    ? Math.max(
      bufferRentLamports + programRentLamports,
      programDataRentLamports + programRentLamports,
    )
    : bufferRentLamports + deploymentPersistentRentIncreaseLamports;
  const demoAccountRentLamports = 3 * auctionRentLamports
    + 2 * mintRentLamports
    + 10 * tokenAccountRentLamports;
  const deploymentWriteTransactionsEstimate = Math.ceil(programLength / PROGRAM_WRITE_BYTES_PER_TRANSACTION);
  const deploymentFeeEstimateLamports = deploymentWriteTransactionsEstimate * BASE_TRANSACTION_FEE_LAMPORTS;
  const calculatedMinimumLamports = deploymentPeakRentLamports
    + demoAccountRentLamports
    + deploymentFeeEstimateLamports
    + AUTHORITY_DEMO_FEE_ESTIMATE_LAMPORTS;
  const authorityFundingTargetLamports = ceilToMultiple(
    calculatedMinimumLamports + AUTHORITY_FUNDING_RESERVE_LAMPORTS,
    FUNDING_ROUNDING_LAMPORTS,
  );
  return {
    programLength,
    accountBytes: {
      buffer: programBufferBytes,
      programData: programDataBytes,
      program: PROGRAM_ACCOUNT_BYTES,
      auction: 8 + 204 + 4 + MAX_ORDERS * 61,
      mint: TOKEN_MINT_ACCOUNT_BYTES,
      tokenAccount: TOKEN_ACCOUNT_BYTES,
    },
    rentLamports: {
      buffer: bufferRentLamports,
      programData: programDataRentLamports,
      program: programRentLamports,
      auction: auctionRentLamports,
      mint: mintRentLamports,
      tokenAccount: tokenAccountRentLamports,
    },
    deploymentMode: existingDeployment.mode,
    existingProgramDataAddress: existingDeployment.programDataAddress?.toBase58() ?? null,
    deploymentPersistentRentIncreaseLamports,
    deploymentPeakRentLamports,
    demoAccountRentLamports,
    deploymentWriteTransactionsEstimate,
    deploymentFeeEstimateLamports,
    authorityDemoFeeEstimateLamports: AUTHORITY_DEMO_FEE_ESTIMATE_LAMPORTS,
    calculatedMinimumLamports,
    reserveLamports: AUTHORITY_FUNDING_RESERVE_LAMPORTS,
    authorityFundingTargetLamports,
    buyerFundingTargetLamports: BUYER_OBSERVED_FEES_LAMPORTS + ROLE_WALLET_RESERVE_LAMPORTS,
    sellerFundingTargetLamports: SELLER_OBSERVED_FEES_LAMPORTS + ROLE_WALLET_RESERVE_LAMPORTS,
  };
}

function executeDeploy(authorityPath, programIdPath) {
  execFileSync(PROGRAM_BIN, [
    "program", "deploy", DEPLOY_PATH,
    "--url", CLUSTER_RPC,
    "--keypair", authorityPath,
    "--program-id", programIdPath,
    "--upgrade-authority", authorityPath,
    "--commitment", "finalized",
    "--use-tpu-client",
  ], { cwd: ROOT, stdio: "inherit" });
}

async function loadProgramKeypair() {
  let keypairContents;
  try {
    keypairContents = await readFile(PROGRAM_ID_PATH, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Program keypair is missing. Run `npm run build:program` before the auction demo.");
    throw error;
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairContents)));
  const programSource = await readFile(path.join(ROOT, "programs/callwindow-escrow/src/lib.rs"), "utf8");
  const anchorConfig = await readFile(path.join(ROOT, "Anchor.toml"), "utf8");
  const declaredId = programSource.match(/^declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\);$/m)?.[1];
  const configuredIds = [...anchorConfig.matchAll(/^callwindow_escrow = "([1-9A-HJ-NP-Za-km-z]+)"$/gm)].map((match) => match[1]);
  invariant(declaredId === keypair.publicKey.toBase58()
    && configuredIds.length === 2
    && configuredIds.every((id) => id === keypair.publicKey.toBase58()),
  "The generated program ID, Rust declaration, and Anchor.toml do not match. Run `npm run build:program` to synchronize and rebuild.");
  return keypair;
}

function u8(value) {
  return Uint8Array.of(value);
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

function i64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
  return bytes;
}

function joinBytes(...values) {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

async function discriminator(name) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(digest).slice(0, 8);
}

async function instruction(programId, name, args, keys) {
  return new TransactionInstruction({
    programId,
    keys,
    data: joinBytes(await discriminator(name), ...args),
  });
}

async function sendFinalized(payer, instructionList, signers = [payer]) {
  const tx = new Transaction().add(...instructionList);
  tx.feePayer = payer.publicKey;
  let signature;
  let blockhash;
  let lastValidBlockHeight;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed"));
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.sign(...signers);
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), {
        preflightCommitment: "confirmed",
        maxRetries: 5,
      });
      break;
    } catch (error) {
      if (attempt === 0 && String(error?.message ?? error).includes("Blockhash not found")) continue;
      throw error;
    }
  }
  invariant(signature, "The finalized transaction did not receive a signature.");
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "finalized");
  invariant(!confirmation.value.err, `Transaction ${signature} did not reach successful finalized state`);
  let transaction;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    transaction = await connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (transaction?.meta) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  invariant(transaction?.meta && !transaction.meta.err, `Transaction ${signature} did not reach successful finalized state`);
  return {
    signature,
    status: "finalized",
    explorerUrl: CLUSTER_NAME === "devnet"
      ? `https://explorer.solana.com/tx/${signature}?cluster=devnet`
      : null,
    feeLamports: transaction.meta.fee,
    computeUnitsConsumed: transaction.meta.computeUnitsConsumed ?? null,
  };
}

async function getFinalizedTimestamp() {
  const slot = await connection.getSlot("finalized");
  const blockTime = await connection.getBlockTime(slot);
  return Number.isSafeInteger(blockTime) ? blockTime : null;
}

async function waitForCutoff(cutoffTime) {
  while (true) {
    const chainTime = await getFinalizedTimestamp();
    if (chainTime !== null && chainTime >= cutoffTime) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function createAuction({ programId, authority, baseMint, quoteMint, auctionId, cutoffTime }) {
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(BigInt(auctionId));
  const [auction] = PublicKey.findProgramAddressSync(
    [Buffer.from("auction"), authority.publicKey.toBuffer(), idBytes],
    programId,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), auction.toBuffer()],
    programId,
  );
  const baseVault = getAssociatedTokenAddressSync(baseMint, vaultAuthority, true);
  const quoteVault = getAssociatedTokenAddressSync(quoteMint, vaultAuthority, true);
  const ix = await instruction(programId, "create_auction", [
    u64(auctionId),
    u16(FIRST_TICK_CENTS),
    u8(CANDIDATE_TICK_COUNT),
    u16(OPENING_REFERENCE_CENTS),
    i64(cutoffTime),
  ], [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: auction, isSigner: false, isWritable: true },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: baseVault, isSigner: false, isWritable: true },
    { pubkey: quoteVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ]);
  const tx = await sendFinalized(authority, [ix]);
  return { auction, vaultAuthority, baseVault, quoteVault, auctionId: String(auctionId), createTx: tx };
}

async function orderInstruction({ programId, auction, vaultAuthority, baseVault, quoteVault, baseMint, quoteMint, owner, side, priceCents, quantity, name }) {
  const baseAta = getAssociatedTokenAddressSync(baseMint, owner.publicKey);
  const quoteAta = getAssociatedTokenAddressSync(quoteMint, owner.publicKey);
  return instruction(programId, name, name === "place_order"
    ? [u8(side), u16(priceCents), u64(quantity)]
    : [u8(quantity)], [
      { pubkey: auction, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: baseAta, isSigner: false, isWritable: true },
      { pubkey: quoteAta, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: baseVault, isSigner: false, isWritable: true },
      { pubkey: quoteVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ]);
}

async function claimInstruction({ programId, auction, vaultAuthority, baseVault, quoteVault, baseMint, quoteMint, owner, orderIndex }) {
  const baseAta = getAssociatedTokenAddressSync(baseMint, owner.publicKey);
  const quoteAta = getAssociatedTokenAddressSync(quoteMint, owner.publicKey);
  return instruction(programId, "claim_order", [u8(orderIndex)], [
    { pubkey: auction, isSigner: false, isWritable: true },
    { pubkey: owner.publicKey, isSigner: false, isWritable: false },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: baseAta, isSigner: false, isWritable: true },
    { pubkey: quoteAta, isSigner: false, isWritable: true },
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: baseVault, isSigner: false, isWritable: true },
    { pubkey: quoteVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ]);
}

async function closeInstruction(programId, auction, caller) {
  return instruction(programId, "close_auction", [], [
    { pubkey: auction, isSigner: false, isWritable: true },
    { pubkey: caller.publicKey, isSigner: true, isWritable: false },
  ]);
}

async function tokenAmount(mint, owner) {
  const account = await getAccount(connection, getAssociatedTokenAddressSync(mint, owner));
  return account.amount;
}

function decodeAuctionAccount(accountInfo, programId) {
  invariant(accountInfo && accountInfo.owner.equals(programId), "The finalized auction account is missing or owned by another program.");
  const data = accountInfo.data;
  const expectedSize = 8 + 204 + 4 + MAX_ORDERS * 61;
  invariant(data.length === expectedSize, `Auction account size ${data.length} did not match the expected ${expectedSize} bytes.`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  const readKey = () => {
    const key = new PublicKey(data.slice(offset, offset + 32)).toBase58();
    offset += 32;
    return key;
  };
  const readU8 = () => data[offset++];
  const readU16 = () => { const value = view.getUint16(offset, true); offset += 2; return value; };
  const readU32 = () => { const value = view.getUint32(offset, true); offset += 4; return value; };
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
  auction.bump = readU8();
  auction.vaultBump = readU8();
  const storageLength = readU32();
  invariant(storageLength === MAX_ORDERS && auction.orderCount <= storageLength, "Auction order storage exceeded its fixed cap.");
  auction.orders = [];
  for (let index = 0; index < storageLength; index += 1) {
    const order = {
      index,
      owner: readKey(),
      side: readU8(),
      status: readU8(),
      limitPriceCents: readU16(),
      quantityBaseUnits: readU64(),
      escrowedQuote: readU64(),
      filledBaseUnits: readU64(),
      claimed: readU8() === 1,
    };
    if (index < auction.orderCount) auction.orders.push(order);
  }
  invariant(offset === data.length, "Auction account decoding did not consume the complete bounded layout.");
  return auction;
}

async function ensureAta(payer, owner, mint) {
  const address = getAssociatedTokenAddressSync(mint, owner.publicKey);
  const existing = await connection.getAccountInfo(address, "finalized");
  if (!existing) {
    const setupTx = await sendFinalized(payer, [createAssociatedTokenAccountInstruction(
      payer.publicKey,
      address,
      owner.publicKey,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )]);
    return { address, setupTx };
  }
  const account = await getAccount(connection, address, "finalized");
  invariant(account.mint.equals(mint) && account.owner.equals(owner.publicKey),
    `Existing associated token account ${address.toBase58()} has the wrong owner or mint.`);
  return { address, setupTx: null };
}

async function loadOrCreateMint(authority, decimals, providedAddress, label) {
  if (!providedAddress) {
    invariant(CLUSTER_NAME !== "devnet",
      `Public devnet resume requires CALLWINDOW_${label.toUpperCase()}_MINT so the runner cannot create a duplicate mint.`);
    return {
      mint: await createMint(connection, authority, authority.publicKey, null, decimals),
      created: true,
      transaction: null,
    };
  }
  const mint = new PublicKey(providedAddress);
  const info = await getMint(connection, mint, "finalized");
  invariant(info.decimals === decimals, `${label} mint ${mint.toBase58()} has ${info.decimals} decimals; expected ${decimals}.`);
  invariant(info.mintAuthority?.equals(authority.publicKey), `${label} mint ${mint.toBase58()} is not controlled by the demo authority.`);
  invariant(info.freezeAuthority === null, `${label} mint ${mint.toBase58()} unexpectedly has a freeze authority.`);
  return { mint, created: false, transaction: null };
}

async function ensureMinted(authority, mint, destination, amount, label) {
  const account = await getAccount(connection, destination, "finalized");
  const currentAmount = account.amount;
  const expectedAmount = BigInt(amount);
  if (currentAmount === expectedAmount) return null;
  invariant(currentAmount === 0n, `${label} already holds ${currentAmount} units; refusing to mint a duplicate amount.`);
  return {
    label,
    wallet: "authority",
    ...await sendFinalized(authority, [createMintToInstruction(
      mint,
      destination,
      authority.publicKey,
      amount,
      [],
      TOKEN_PROGRAM_ID,
    )]),
  };
}

function tokenDelta(before, after) {
  return (after - before).toString();
}

async function main() {
  invariant(MAX_ORDERS === 32 && MAX_CANDIDATE_TICKS === 101, "The auction runner caps do not match the tested clearing caps.");
  await mkdir(KEY_DIR, { recursive: true, mode: 0o700 });
  const authority = await loadOrCreateKeypair("authority");
  const buyer = await loadOrCreateKeypair("buyer");
  const seller = await loadOrCreateKeypair("seller");
  const programKeypair = await loadProgramKeypair();
  const programId = programKeypair.publicKey;
  const publicRoles = {
    authority: authority.publicKey.toBase58(),
    buyer: buyer.publicKey.toBase58(),
    seller: seller.publicKey.toBase58(),
  };
  invariant(new Set(Object.values(publicRoles)).size === 3, "Authority, buyer, and seller must use separate wallets.");

  console.log(`Checking finalized balances for three separate ${CLUSTER_NAME} wallets.`);
  const programLength = (await stat(DEPLOY_PATH)).size;
  const existingDeployment = await inspectExistingDeployment(programId, authority.publicKey);
  const fundingEstimate = await calculateFundingEstimate(programLength, existingDeployment);
  const { authorityFundingTargetLamports } = fundingEstimate;
  console.log(`Authority funding estimate for ${fundingEstimate.deploymentMode} deployment: ${fundingEstimate.calculatedMinimumLamports} lamports minimum; target ${authorityFundingTargetLamports} lamports including ${fundingEstimate.reserveLamports} lamports reserve.`);
  console.log(`Built program ${fundingEstimate.programLength} bytes; peak deployment rent ${fundingEstimate.deploymentPeakRentLamports}; demo account rent ${fundingEstimate.demoAccountRentLamports}; estimated deployment fees ${fundingEstimate.deploymentFeeEstimateLamports}; observed authority operation fees ${fundingEstimate.authorityDemoFeeEstimateLamports} lamports.`);
  await ensureClusterFunds(authority, authorityFundingTargetLamports);
  await ensureClusterFunds(buyer, fundingEstimate.buyerFundingTargetLamports);
  await ensureClusterFunds(seller, fundingEstimate.sellerFundingTargetLamports);
  console.log(`Authority ${publicRoles.authority}; buyer ${publicRoles.buyer}; seller ${publicRoles.seller}`);

  const authorityLamportsBeforeDeploy = await connection.getBalance(authority.publicKey, "finalized");
  const buyerLamportsBeforeRun = await connection.getBalance(buyer.publicKey, "finalized");
  const sellerLamportsBeforeRun = await connection.getBalance(seller.publicKey, "finalized");
  const shouldDeploy = existingDeployment.mode === "fresh";
  if (shouldDeploy) {
    console.log(`Deploying program ${programId.toBase58()} to ${CLUSTER_NAME}.`);
    executeDeploy(path.join(KEY_DIR, "authority.json"), PROGRAM_ID_PATH);
  } else {
    console.log(`Using the existing finalized ${CLUSTER_NAME} deployment ${programId.toBase58()} without redeploying.`);
  }
  const authorityLamportsAfterDeploy = await connection.getBalance(authority.publicKey, "finalized");
  const programAccount = await connection.getAccountInfo(programId, "finalized");
  invariant(programAccount?.executable, `The ${CLUSTER_NAME} program account is not executable at finalized commitment.`);
  invariant(programAccount.data.length >= PROGRAM_ACCOUNT_BYTES, "The deployed upgradeable program account data is incomplete.");
  const programDataAddress = new PublicKey(programAccount.data.subarray(4, 36));
  if (existingDeployment.programDataAddress) {
    invariant(programDataAddress.equals(existingDeployment.programDataAddress), "The upgraded program changed its ProgramData address unexpectedly.");
  }
  const programDataAccount = await connection.getAccountInfo(programDataAddress, "finalized");
  invariant(programDataAccount, "The deployed ProgramData account is missing at finalized commitment.");
  const deploymentCostLamports = authorityLamportsBeforeDeploy - authorityLamportsAfterDeploy;
  const deploymentPersistentRentIncreaseLamports = Math.max(0, programAccount.lamports - existingDeployment.programAccountLamports)
    + Math.max(0, programDataAccount.lamports - existingDeployment.programDataLamports);
  const deploymentFeeLamportsMeasured = deploymentCostLamports - deploymentPersistentRentIncreaseLamports;
  invariant(deploymentFeeLamportsMeasured >= 0, "Measured deployment cost did not cover incremental program account rent.");

  const baseMintRecord = await loadOrCreateMint(authority, BASE_MINT_DECIMALS, RESUMED_BASE_MINT, "base");
  const quoteMintRecord = await loadOrCreateMint(authority, QUOTE_MINT_DECIMALS, RESUMED_QUOTE_MINT, "quote");
  const baseMint = baseMintRecord.mint;
  const quoteMint = quoteMintRecord.mint;
  const buyerBase = await ensureAta(authority, buyer, baseMint);
  const buyerQuote = await ensureAta(authority, buyer, quoteMint);
  const sellerBase = await ensureAta(authority, seller, baseMint);
  const sellerQuote = await ensureAta(authority, seller, quoteMint);
  const setupTransactions = [
    ...(buyerBase.setupTx ? [{ label: "Create buyer base ATA", wallet: "authority", ...buyerBase.setupTx }] : []),
    ...(buyerQuote.setupTx ? [{ label: "Create buyer quote ATA", wallet: "authority", ...buyerQuote.setupTx }] : []),
    ...(sellerBase.setupTx ? [{ label: "Create seller base ATA", wallet: "authority", ...sellerBase.setupTx }] : []),
    ...(sellerQuote.setupTx ? [{ label: "Create seller quote ATA", wallet: "authority", ...sellerQuote.setupTx }] : []),
  ];
  const sellerBaseMintTx = await ensureMinted(authority, baseMint, sellerBase.address, 100_000, "Seller base mint");
  const buyerQuoteMintTx = await ensureMinted(authority, quoteMint, buyerQuote.address, 2_000_000_000, "Buyer quote mint");
  if (sellerBaseMintTx) setupTransactions.push(sellerBaseMintTx);
  if (buyerQuoteMintTx) setupTransactions.push(buyerQuoteMintTx);
  const mintProof = {
    base: { name: "DEMO-EQUITY", address: baseMint.toBase58(), decimals: BASE_MINT_DECIMALS },
    quote: { name: "DEMO-USD", address: quoteMint.toBase58(), decimals: QUOTE_MINT_DECIMALS },
    disclosure: "Test demonstration mints with no equity backing and no connection to the PreStocks KALSHI mint.",
  };

  const now = Math.floor(Date.now() / 1000);
  const chainTimeAtOpen = await getFinalizedTimestamp();
  invariant(chainTimeAtOpen !== null, "Could not read finalized chain time before opening the auctions.");
  const cutoffTime = chainTimeAtOpen + CUTOFF_SECONDS;
  const matched = await createAuction({
    programId, authority, baseMint, quoteMint, auctionId: BigInt(now) * 10n, cutoffTime,
  });
  const refund = await createAuction({
    programId, authority, baseMint, quoteMint, auctionId: BigInt(now) * 10n + 1n, cutoffTime,
  });
  const maximum = await createAuction({
    programId, authority, baseMint, quoteMint, auctionId: BigInt(now) * 10n + 2n, cutoffTime,
  });
  const txs = [
    ...setupTransactions,
    { label: "Create matched test auction", wallet: "authority", ...matched.createTx },
    { label: "Create no-cross refund auction", wallet: "authority", ...refund.createTx },
    { label: "Create 32-order maximum test auction", wallet: "authority", ...maximum.createTx },
  ];

  const cancelOrder = await orderInstruction({
    programId, ...matched, baseMint, quoteMint, owner: buyer, side: 0, priceCents: 1_950, quantity: 50, name: "place_order",
  });
  const quoteBeforeCancellation = await tokenAmount(quoteMint, buyer.publicKey);
  txs.push({ label: "Place cancellable buy order", wallet: "buyer", ...await sendFinalized(buyer, [cancelOrder]) });
  const cancelIx = await orderInstruction({
    programId, ...matched, baseMint, quoteMint, owner: buyer, quantity: 0, name: "cancel_order",
  });
  txs.push({ label: "Cancel and fully refund test order", wallet: "buyer", ...await sendFinalized(buyer, [cancelIx]) });
  const quoteAfterCancellation = await tokenAmount(quoteMint, buyer.publicKey);
  invariant(quoteAfterCancellation === quoteBeforeCancellation, "The pre-cutoff cancel did not return the buyer's full quote escrow.");

  const buyerQuoteBefore = await tokenAmount(quoteMint, buyer.publicKey);
  const buyerBaseBefore = await tokenAmount(baseMint, buyer.publicKey);
  const sellerQuoteBefore = await tokenAmount(quoteMint, seller.publicKey);
  const sellerBaseBefore = await tokenAmount(baseMint, seller.publicKey);
  const matchedBuy = await orderInstruction({
    programId, ...matched, baseMint, quoteMint, owner: buyer, side: 0, priceCents: 2_010, quantity: 500, name: "place_order",
  });
  txs.push({ label: "Place funded matched buy order", wallet: "buyer", ...await sendFinalized(buyer, [matchedBuy]) });
  const matchedSell = await orderInstruction({
    programId, ...matched, baseMint, quoteMint, owner: seller, side: 1, priceCents: 1_990, quantity: 300, name: "place_order",
  });
  txs.push({ label: "Place funded matched sell order", wallet: "seller", ...await sendFinalized(seller, [matchedSell]) });

  const refundBuy = await orderInstruction({
    programId, ...refund, baseMint, quoteMint, owner: buyer, side: 0, priceCents: 1_950, quantity: 100, name: "place_order",
  });
  txs.push({ label: "Place no-cross buy order", wallet: "buyer", ...await sendFinalized(buyer, [refundBuy]) });
  const refundSell = await orderInstruction({
    programId, ...refund, baseMint, quoteMint, owner: seller, side: 1, priceCents: 2_050, quantity: 100, name: "place_order",
  });
  txs.push({ label: "Place no-cross sell order", wallet: "seller", ...await sendFinalized(seller, [refundSell]) });

  const maximumBuyOrders = [];
  const maximumSellOrders = [];
  for (let index = 0; index < MAX_ORDERS / 2; index += 1) {
    maximumBuyOrders.push(await orderInstruction({
      programId, ...maximum, baseMint, quoteMint, owner: buyer, side: 0, priceCents: OPENING_REFERENCE_CENTS, quantity: 100, name: "place_order",
    }));
    maximumSellOrders.push(await orderInstruction({
      programId, ...maximum, baseMint, quoteMint, owner: seller, side: 1, priceCents: OPENING_REFERENCE_CENTS, quantity: 100, name: "place_order",
    }));
  }
  for (let index = 0; index < maximumBuyOrders.length; index += 8) {
    txs.push({ label: `Place maximum test buy orders ${index + 1}–${index + 8}`, wallet: "buyer", ...await sendFinalized(buyer, maximumBuyOrders.slice(index, index + 8)) });
  }
  for (let index = 0; index < maximumSellOrders.length; index += 8) {
    txs.push({ label: `Place maximum test sell orders ${index + 1}–${index + 8}`, wallet: "seller", ...await sendFinalized(seller, maximumSellOrders.slice(index, index + 8)) });
  }

  const currentChainTime = await getFinalizedTimestamp();
  const secondsUntilCutoff = currentChainTime === null ? CUTOFF_SECONDS : cutoffTime - currentChainTime;
  if (secondsUntilCutoff > 0) {
    console.log(`Waiting ${secondsUntilCutoff} seconds for the fixed order window to end.`);
    await waitForCutoff(cutoffTime);
  }
  const matchedClose = await sendFinalized(authority, [await closeInstruction(programId, matched.auction, authority)]);
  txs.push({ label: "Close matched auction at cutoff", wallet: "authority", ...matchedClose });
  const refundClose = await sendFinalized(authority, [await closeInstruction(programId, refund.auction, authority)]);
  txs.push({ label: "Close no-cross auction at cutoff", wallet: "authority", ...refundClose });
  const maximumClose = await sendFinalized(authority, [await closeInstruction(programId, maximum.auction, authority)]);
  txs.push({ label: "Close maximum 32-order, 101-tick auction", wallet: "authority", ...maximumClose });

  for (const [label, transaction] of [
    ["Matched auction close", matchedClose],
    ["No-cross auction close", refundClose],
    ["Maximum-bound auction close", maximumClose],
  ]) {
    invariant(Number.isSafeInteger(transaction.computeUnitsConsumed) && transaction.computeUnitsConsumed > 0,
      `${label} finalized transaction did not expose computeUnitsConsumed.`);
    invariant(Number.isSafeInteger(transaction.feeLamports) && transaction.feeLamports >= 0,
      `${label} finalized transaction did not expose a finite fee in lamports.`);
  }

  const closeDetails = {
    matched: {
      computeUnitsConsumed: matchedClose.computeUnitsConsumed,
      feeLamports: matchedClose.feeLamports,
    },
    noCrossRefund: {
      computeUnitsConsumed: refundClose.computeUnitsConsumed,
      feeLamports: refundClose.feeLamports,
    },
    maxBounds: {
      maxOrders: MAX_ORDERS,
      candidateTicks: MAX_CANDIDATE_TICKS,
      computeUnitsConsumed: maximumClose.computeUnitsConsumed,
      feeLamports: maximumClose.feeLamports,
    },
    highestObservedComputeUnits: Math.max(
      matchedClose.computeUnitsConsumed ?? 0,
      refundClose.computeUnitsConsumed ?? 0,
      maximumClose.computeUnitsConsumed ?? 0,
    ),
  };

  const matchedClosed = decodeAuctionAccount(await connection.getAccountInfo(matched.auction, "finalized"), programId);
  const refundClosed = decodeAuctionAccount(await connection.getAccountInfo(refund.auction, "finalized"), programId);
  invariant(matchedClosed.state === AUCTION_CLOSED
    && matchedClosed.clearingPriceCents === OPENING_REFERENCE_CENTS
    && matchedClosed.matchedBase === 300n
    && matchedClosed.orders[0].status === ORDER_CANCELLED
    && matchedClosed.orders[0].claimed
    && matchedClosed.orders[1].filledBaseUnits === 300n
    && matchedClosed.orders[2].filledBaseUnits === 300n,
  "The finalized matched auction state did not match its expected price, fills, or cancellation.");
  invariant(refundClosed.state === AUCTION_CLOSED
    && refundClosed.clearingPriceCents === 0
    && refundClosed.matchedBase === 0n
    && refundClosed.orders[0].filledBaseUnits === 0n
    && refundClosed.orders[1].filledBaseUnits === 0n,
  "The finalized no-cross auction did not close with zero fills and a refund path.");
  const maximumClosed = decodeAuctionAccount(await connection.getAccountInfo(maximum.auction, "finalized"), programId);
  invariant(maximumClosed.state === AUCTION_CLOSED
    && maximumClosed.orderCount === MAX_ORDERS
    && maximumClosed.candidateTickCount === MAX_CANDIDATE_TICKS
    && maximumClosed.clearingPriceCents === OPENING_REFERENCE_CENTS
    && maximumClosed.matchedBase === 1_600n
    && maximumClosed.orders.slice(0, MAX_ORDERS).every((order) => order.filledBaseUnits === 100n),
  "The finalized maximum-bound auction did not clear all 32 orders across 101 candidate ticks.");

  const claimMatchedBuyer = await claimInstruction({ programId, ...matched, baseMint, quoteMint, owner: buyer, orderIndex: 1 });
  txs.push({ label: "Buyer claims matched shares and quote refund", wallet: "buyer", ...await sendFinalized(buyer, [claimMatchedBuyer]) });
  const claimMatchedSeller = await claimInstruction({ programId, ...matched, baseMint, quoteMint, owner: seller, orderIndex: 2 });
  txs.push({ label: "Seller claims matched USDC test proceeds", wallet: "seller", ...await sendFinalized(seller, [claimMatchedSeller]) });
  const buyerQuoteAfterMatchedClaims = await tokenAmount(quoteMint, buyer.publicKey);
  const sellerBaseAfterMatchedClaims = await tokenAmount(baseMint, seller.publicKey);
  const claimRefundBuyer = await claimInstruction({ programId, ...refund, baseMint, quoteMint, owner: buyer, orderIndex: 0 });
  txs.push({ label: "Buyer claims full no-cross quote refund", wallet: "buyer", ...await sendFinalized(buyer, [claimRefundBuyer]) });
  const claimRefundSeller = await claimInstruction({ programId, ...refund, baseMint, quoteMint, owner: seller, orderIndex: 1 });
  txs.push({ label: "Seller claims full no-cross base refund", wallet: "seller", ...await sendFinalized(seller, [claimRefundSeller]) });
  const buyerQuoteAfterRefundClaims = await tokenAmount(quoteMint, buyer.publicKey);
  const sellerBaseAfterRefundClaims = await tokenAmount(baseMint, seller.publicKey);

  for (const [wallet, startIndex, label] of [[buyer, 0, "buyer"], [seller, 16, "seller"]]) {
    const claims = [];
    for (let orderIndex = startIndex; orderIndex < startIndex + 16; orderIndex += 1) {
      claims.push(await claimInstruction({ programId, ...maximum, baseMint, quoteMint, owner: wallet, orderIndex }));
    }
    for (let index = 0; index < claims.length; index += 8) {
      txs.push({ label: `Claim maximum test ${label} orders ${index + 1}–${index + 8}`, wallet: label, ...await sendFinalized(wallet, claims.slice(index, index + 8)) });
    }
  }

  const buyerQuoteAfter = await tokenAmount(quoteMint, buyer.publicKey);
  const buyerBaseAfter = await tokenAmount(baseMint, buyer.publicKey);
  const sellerQuoteAfter = await tokenAmount(quoteMint, seller.publicKey);
  const sellerBaseAfter = await tokenAmount(baseMint, seller.publicKey);
  const matchedBaseVault = await getAccount(connection, matched.baseVault);
  const matchedQuoteVault = await getAccount(connection, matched.quoteVault);
  const refundBaseVault = await getAccount(connection, refund.baseVault);
  const refundQuoteVault = await getAccount(connection, refund.quoteVault);
  const maximumBaseVault = await getAccount(connection, maximum.baseVault);
  const maximumQuoteVault = await getAccount(connection, maximum.quoteVault);
  const matchedClaimed = decodeAuctionAccount(await connection.getAccountInfo(matched.auction, "finalized"), programId);
  const refundClaimed = decodeAuctionAccount(await connection.getAccountInfo(refund.auction, "finalized"), programId);
  const maximumClaimed = decodeAuctionAccount(await connection.getAccountInfo(maximum.auction, "finalized"), programId);
  invariant(matchedClaimed.claimedCount === 2
    && matchedClaimed.orders[1].claimed
    && matchedClaimed.orders[2].claimed
    && refundClaimed.claimedCount === 2
    && refundClaimed.orders[0].claimed
    && refundClaimed.orders[1].claimed
    && maximumClaimed.claimedCount === MAX_ORDERS
    && maximumClaimed.orders.every((order) => order.claimed),
  "The expected buyer and seller order claims were not recorded in finalized auction state.");
  const reconciliation = {
    buyerBaseDelta: tokenDelta(buyerBaseBefore, buyerBaseAfter),
    buyerQuoteDelta: tokenDelta(buyerQuoteBefore, buyerQuoteAfter),
    sellerBaseDelta: tokenDelta(sellerBaseBefore, sellerBaseAfter),
    sellerQuoteDelta: tokenDelta(sellerQuoteBefore, sellerQuoteAfter),
    buyerBaseFinalTokenUnits: buyerBaseAfter.toString(),
    buyerQuoteFinalTokenUnits: buyerQuoteAfter.toString(),
    sellerBaseFinalTokenUnits: sellerBaseAfter.toString(),
    sellerQuoteFinalTokenUnits: sellerQuoteAfter.toString(),
    buyerNoCrossRefund: tokenDelta(buyerQuoteAfterMatchedClaims, buyerQuoteAfterRefundClaims),
    sellerNoCrossRefund: tokenDelta(sellerBaseAfterMatchedClaims, sellerBaseAfterRefundClaims),
    cancelledBuyerQuoteDelta: tokenDelta(quoteBeforeCancellation, quoteAfterCancellation),
    matchedBaseVaultFinal: matchedBaseVault.amount.toString(),
    matchedQuoteVaultFinal: matchedQuoteVault.amount.toString(),
    noCrossBaseVaultFinal: refundBaseVault.amount.toString(),
    noCrossQuoteVaultFinal: refundQuoteVault.amount.toString(),
    maximumBaseVaultFinal: maximumBaseVault.amount.toString(),
    maximumQuoteVaultFinal: maximumQuoteVault.amount.toString(),
    result: "all six demo vault balances must be zero after claims",
  };
  invariant(matchedBaseVault.amount === 0n && matchedQuoteVault.amount === 0n
    && refundBaseVault.amount === 0n && refundQuoteVault.amount === 0n
    && maximumBaseVault.amount === 0n && maximumQuoteVault.amount === 0n,
  "Token balances did not reconcile to zero across the matched and refund auctions.");
  invariant(buyerBaseAfter - buyerBaseBefore === 1_900n, "Buyer did not receive the expected 19 demo shares across the two matched auctions.");
  invariant(sellerQuoteAfter - sellerQuoteBefore === 380_000_000n, "Seller did not receive the expected 380 DEMO-USD across the two matched auctions.");
  invariant(sellerBaseBefore - sellerBaseAfter === 1_900n, "Seller did not transfer the expected 19 demo shares across the two matched auctions.");
  invariant(buyerQuoteBefore - buyerQuoteAfter === 380_000_000n, "Buyer net DEMO-USD cost did not reconcile across the two matched auctions.");
  invariant(buyerQuoteAfterRefundClaims - buyerQuoteAfterMatchedClaims === 19_500_000n, "Buyer did not receive the full no-cross quote refund.");
  invariant(sellerBaseAfterRefundClaims - sellerBaseAfterMatchedClaims === 100n, "Seller did not receive the full no-cross base refund.");
  invariant(buyerBaseAfter - buyerBaseBefore === 300n + 1_600n, "Maximum-bound buyer share claims did not reconcile.");
  invariant(sellerQuoteAfter - sellerQuoteBefore === 60_000_000n + 320_000_000n, "Maximum-bound seller proceeds did not reconcile.");

  const authorityLamportsFinal = await connection.getBalance(authority.publicKey, "finalized");
  const buyerLamportsFinal = await connection.getBalance(buyer.publicKey, "finalized");
  const sellerLamportsFinal = await connection.getBalance(seller.publicKey, "finalized");
  const lamportReconciliation = {
    authority: {
      fundedBalanceLamports: authorityLamportsBeforeDeploy,
      postDeployBalanceLamports: authorityLamportsAfterDeploy,
      finalBalanceLamports: authorityLamportsFinal,
      deployCostLamports: deploymentCostLamports,
      totalDemoCostLamports: authorityLamportsBeforeDeploy - authorityLamportsFinal,
    },
    buyer: {
      fundedBalanceLamports: buyerLamportsBeforeRun,
      finalBalanceLamports: buyerLamportsFinal,
      totalFeeLamports: buyerLamportsBeforeRun - buyerLamportsFinal,
    },
    seller: {
      fundedBalanceLamports: sellerLamportsBeforeRun,
      finalBalanceLamports: sellerLamportsFinal,
      totalFeeLamports: sellerLamportsBeforeRun - sellerLamportsFinal,
    },
  };

  const manifest = {
    network: CLUSTER_NAME,
    clusterRpc: CLUSTER_RPC,
    programId: programId.toBase58(),
    builtProgramBytes: programLength,
    deployment: {
      status: shouldDeploy ? "deployed" : "existing-finalized-deployment-reused",
      signature: DEPLOYMENT_TRANSACTION,
      explorerUrl: DEPLOYMENT_TRANSACTION && CLUSTER_NAME === "devnet"
        ? `https://explorer.solana.com/tx/${DEPLOYMENT_TRANSACTION}?cluster=devnet`
        : null,
      programDataAddress: programDataAddress.toBase58(),
    },
    fundingEstimate,
    authorityFundingTargetLamports,
    deploymentCostLamports,
    deploymentCostBreakdown: {
      mode: existingDeployment.mode,
      persistentRentIncreaseLamports: deploymentPersistentRentIncreaseLamports,
      measuredFeeLamports: deploymentFeeLamportsMeasured,
      feeEstimateLamports: fundingEstimate.deploymentFeeEstimateLamports,
      programDataAddress: programDataAddress.toBase58(),
      programDataBytes: programDataAccount.data.length,
      programAccountBytes: programAccount.data.length,
    },
    authority: publicRoles.authority,
    separateWallets: { buyer: publicRoles.buyer, seller: publicRoles.seller },
    auctionAddress: matched.auction.toBase58(),
    auctionId: matched.auctionId,
    orderWindowSeconds: CUTOFF_SECONDS,
    cutoffTime: new Date(cutoffTime * 1_000).toISOString(),
    caps: { maxOrders: MAX_ORDERS, maxCandidateTicks: MAX_CANDIDATE_TICKS, priceTickCents: 1 },
    resumedSetup: {
      mode: baseMintRecord.created || quoteMintRecord.created ? "fresh-mints" : "existing-mints",
      baseMintCreationSignature: RESUMED_BASE_MINT_TRANSACTION,
      quoteMintCreationSignature: RESUMED_QUOTE_MINT_TRANSACTION,
      existingBuyerBaseAtaSignature: RESUMED_BASE_ATA_TRANSACTION,
      selectedBaseMint: baseMint.toBase58(),
      selectedQuoteMint: quoteMint.toBase58(),
      note: "Existing finalized mints and token accounts were reused; no duplicate mint or ATA was created for the selected pair.",
    },
    mints: mintProof,
    matchedAuction: {
      address: matched.auction.toBase58(),
      orderCount: 3,
      cancelRefundTested: true,
      clearingPriceCents: OPENING_REFERENCE_CENTS,
      matchedBaseUnits: 300,
      state: "closed and claimed",
    },
    noCrossAuction: {
      address: refund.auction.toBase58(),
      orderCount: 2,
      clearingPriceCents: 0,
      matchedBaseUnits: 0,
      state: "closed and fully refunded",
    },
    maximumAuction: {
      address: maximum.auction.toBase58(),
      orderCount: MAX_ORDERS,
      candidateTickCount: MAX_CANDIDATE_TICKS,
      clearingPriceCents: OPENING_REFERENCE_CENTS,
      matchedBaseUnits: 1_600,
      state: "closed and claimed",
    },
    closingCost: closeDetails,
    closingComputeUnits: maximumClose.computeUnitsConsumed,
    closingFeeLamports: maximumClose.feeLamports,
    reconciliation,
    lamportReconciliation,
    transactions: txs,
    finalizedAt: new Date().toISOString(),
  };
  const manifestPath = path.join(KEY_DIR, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`Finalized ${CLUSTER_NAME} flow passed. Proof manifest: ${manifestPath}`);
  console.log(JSON.stringify({ programId: manifest.programId, mints: manifest.mints, auctions: {
    matched: manifest.matchedAuction.address,
    noCrossRefund: manifest.noCrossAuction.address,
    maximum: manifest.maximumAuction.address,
  }, closingCost: manifest.closingCost, reconciliation: manifest.reconciliation,
  fundingEstimate: manifest.fundingEstimate,
  deploymentCostBreakdown: manifest.deploymentCostBreakdown,
  lamportReconciliation: manifest.lamportReconciliation,
  transactions: manifest.transactions.map(({ label, wallet, signature, status }) => ({ label, wallet, signature, status })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
