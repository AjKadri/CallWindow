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
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEVNET = "https://api.devnet.solana.com";
const PROGRAM_ID_PATH = path.join(ROOT, "target/deploy/callwindow_escrow-keypair.json");
const DEPLOY_PATH = path.join(ROOT, "target/deploy/callwindow_escrow.so");
const KEY_DIR = path.join(ROOT, "target/devnet");
const PROGRAM_BIN = path.join(ROOT, ".tools/solana/active_release/bin/solana");
const MAX_ORDERS = 32;
const MAX_CANDIDATE_TICKS = 101;
const FIRST_TICK_CENTS = 1_950;
const OPENING_REFERENCE_CENTS = 2_000;
const CANDIDATE_TICK_COUNT = 101;
const BASE_MINT_DECIMALS = 2;
const QUOTE_MINT_DECIMALS = 6;
const ORDER_ACTIVE = 0;
const ORDER_CANCELLED = 1;
const AUCTION_CLOSED = 1;
const connection = new Connection(DEVNET, "finalized");

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

async function ensureDevnetFunds(keypair, requiredSol) {
  const requiredLamports = requiredSol * LAMPORTS_PER_SOL;
  let balance = await connection.getBalance(keypair.publicKey, "finalized");
  let attempts = 0;
  const maxAttempts = Math.ceil(requiredSol / 2) + 3;
  while (balance < requiredLamports && attempts < maxAttempts) {
    attempts += 1;
    const amount = Math.min(2 * LAMPORTS_PER_SOL, requiredLamports - balance);
    const signature = await connection.requestAirdrop(keypair.publicKey, amount);
    const result = await connection.confirmTransaction(signature, "finalized");
    invariant(!result.value.err, `Devnet faucet transfer failed for ${keypair.publicKey.toBase58()}`);
    balance = await connection.getBalance(keypair.publicKey, "finalized");
  }
  invariant(balance >= requiredLamports, `Devnet wallet ${keypair.publicKey.toBase58()} has ${balance} lamports; ${requiredSol} SOL is required.`);
}

function executeDeploy(authorityPath, programIdPath) {
  execFileSync(PROGRAM_BIN, [
    "program", "deploy", DEPLOY_PATH,
    "--url", DEVNET,
    "--keypair", authorityPath,
    "--program-id", programIdPath,
    "--upgrade-authority", authorityPath,
    "--commitment", "finalized",
    "--use-rpc",
  ], { cwd: ROOT, stdio: "inherit" });
}

async function loadProgramKeypair() {
  let keypairContents;
  try {
    keypairContents = await readFile(PROGRAM_ID_PATH, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Program keypair is missing. Run `npm run build:program` before the devnet demo.");
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
  const signature = await sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "finalized",
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });
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
    feeLamports: transaction.meta.fee,
    computeUnitsConsumed: transaction.meta.computeUnitsConsumed ?? null,
  };
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
  return getOrCreateAssociatedTokenAccount(connection, payer, mint, owner.publicKey);
}

function tokenDelta(before, after) {
  return (after - before).toString();
}

async function main() {
  invariant(MAX_ORDERS === 32 && MAX_CANDIDATE_TICKS === 101, "The devnet runner caps do not match the tested clearing caps.");
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

  console.log("Funding three separate devnet wallets with faucet SOL as needed.");
  const programLength = (await stat(DEPLOY_PATH)).size;
  const dataRent = await connection.getMinimumBalanceForRentExemption(programLength + 128, "finalized");
  const programAccountRent = await connection.getMinimumBalanceForRentExemption(128, "finalized");
  const deploymentSol = Math.ceil((2 * dataRent + programAccountRent + LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL);
  await ensureDevnetFunds(authority, deploymentSol);
  await ensureDevnetFunds(buyer, 1);
  await ensureDevnetFunds(seller, 1);
  console.log(`Authority ${publicRoles.authority}; buyer ${publicRoles.buyer}; seller ${publicRoles.seller}`);

  console.log(`Deploying program ${programId.toBase58()} to devnet.`);
  executeDeploy(path.join(KEY_DIR, "authority.json"), PROGRAM_ID_PATH);
  const programAccount = await connection.getAccountInfo(programId, "finalized");
  invariant(programAccount?.executable, "The devnet program account is not executable at finalized commitment.");

  const baseMint = await createMint(connection, authority, authority.publicKey, null, BASE_MINT_DECIMALS);
  const quoteMint = await createMint(connection, authority, authority.publicKey, null, QUOTE_MINT_DECIMALS);
  const buyerBase = await ensureAta(authority, buyer, baseMint);
  const buyerQuote = await ensureAta(authority, buyer, quoteMint);
  const sellerBase = await ensureAta(authority, seller, baseMint);
  const sellerQuote = await ensureAta(authority, seller, quoteMint);
  await mintTo(connection, authority, baseMint, sellerBase.address, authority, 100_000);
  await mintTo(connection, authority, quoteMint, buyerQuote.address, authority, 2_000_000_000);
  const mintProof = {
    base: { name: "DEMO-EQUITY", address: baseMint.toBase58(), decimals: BASE_MINT_DECIMALS },
    quote: { name: "DEMO-USD", address: quoteMint.toBase58(), decimals: QUOTE_MINT_DECIMALS },
    disclosure: "Devnet demonstration mints with no equity backing and no connection to the PreStocks KALSHI mint.",
  };

  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now + 90;
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

  const secondsUntilCutoff = cutoffTime - Math.floor(Date.now() / 1000);
  if (secondsUntilCutoff > 0) {
    console.log(`Waiting ${secondsUntilCutoff} seconds for the fixed order window to end.`);
    await new Promise((resolve) => setTimeout(resolve, secondsUntilCutoff * 1_000 + 500));
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

  const manifest = {
    network: "devnet",
    clusterRpc: DEVNET,
    programId: programId.toBase58(),
    authority: publicRoles.authority,
    separateWallets: { buyer: publicRoles.buyer, seller: publicRoles.seller },
    auctionAddress: matched.auction.toBase58(),
    auctionId: matched.auctionId,
    cutoffTime: new Date(cutoffTime * 1_000).toISOString(),
    caps: { maxOrders: MAX_ORDERS, maxCandidateTicks: MAX_CANDIDATE_TICKS, priceTickCents: 1 },
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
    transactions: txs,
    finalizedAt: new Date().toISOString(),
  };
  const manifestPath = path.join(KEY_DIR, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`Finalized devnet flow passed. Public proof manifest: ${manifestPath}`);
  console.log(JSON.stringify({ programId: manifest.programId, mints: manifest.mints, auctions: {
    matched: manifest.matchedAuction.address,
    noCrossRefund: manifest.noCrossAuction.address,
  }, closingCost: manifest.closingCost, reconciliation: manifest.reconciliation }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
