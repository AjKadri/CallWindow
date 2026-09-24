import { mkdir, readFile, writeFile } from "node:fs/promises";
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
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.CALLWINDOW_DEVNET_RPC ?? "https://api.devnet.solana.com";
const KEY_DIR = path.join(ROOT, "target", "devnet");
const ROOM_PATH = process.env.CALLWINDOW_ROOM_PATH ?? path.join(KEY_DIR, "auction-room.json");
const PROGRAM_ID = new PublicKey("GxX6X6zZSQSuxEoTHPwaAmKCcpGRVRiB6ERANHzS7Eq9");
const BASE_MINT = new PublicKey("B6ZoEr92PB58bN1MgTXwjZHBUxCZ895ERVdhFJtSQFcP");
const QUOTE_MINT = new PublicKey("7gLQ8vdtYTxbHa4YK9gjjsVe49WiKeH6pi2pV8us8zd4");
const FIRST_TICK_CENTS = 1_950;
const OPENING_REFERENCE_CENTS = 2_000;
const CANDIDATE_TICK_COUNT = 101;
const MAX_ORDERS = 32;
const CUTOFF_SECONDS = Number(process.env.CALLWINDOW_ROOM_CUTOFF_SECONDS ?? 180);

if (!Number.isSafeInteger(CUTOFF_SECONDS) || CUTOFF_SECONDS < 30 || CUTOFF_SECONDS > 86_400) {
  throw new Error("CALLWINDOW_ROOM_CUTOFF_SECONDS must be an integer from 30 to 86400.");
}

const connection = new Connection(RPC, "confirmed");

function invariant(value, message) {
  if (!value) throw new Error(message);
}

async function loadKeypair(name) {
  const values = JSON.parse(await readFile(path.join(KEY_DIR, name + ".json"), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(values));
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
  const bytes = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    bytes.set(value, offset);
    offset += value.length;
  }
  return bytes;
}

async function instruction(programId, name, args, keys) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("global:" + name));
  return new TransactionInstruction({
    programId,
    keys,
    data: joinBytes(new Uint8Array(digest).slice(0, 8), ...args),
  });
}

async function sendFinalized(payer, instructions, signers = [payer]) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = payer.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
  transaction.sign(...signers);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });
  const result = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "finalized",
  );
  invariant(!result.value.err, "Transaction " + signature + " failed at finalized commitment.");
  return {
    signature,
    status: "finalized",
    explorerUrl: "https://explorer.solana.com/tx/" + signature + "?cluster=devnet",
  };
}

function auctionAddresses(authority, auctionId) {
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(BigInt(auctionId));
  const [auction] = PublicKey.findProgramAddressSync(
    [Buffer.from("auction"), authority.publicKey.toBuffer(), idBytes],
    PROGRAM_ID,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), auction.toBuffer()],
    PROGRAM_ID,
  );
  return {
    auction,
    vaultAuthority,
    baseVault: getAssociatedTokenAddressSync(BASE_MINT, vaultAuthority, true),
    quoteVault: getAssociatedTokenAddressSync(QUOTE_MINT, vaultAuthority, true),
  };
}

async function createAuction(authority, auctionId, cutoffTime) {
  const addresses = auctionAddresses(authority, auctionId);
  const createIx = await instruction(PROGRAM_ID, "create_auction", [
    u64(auctionId),
    u16(FIRST_TICK_CENTS),
    u8(CANDIDATE_TICK_COUNT),
    u16(OPENING_REFERENCE_CENTS),
    i64(cutoffTime),
  ], [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: addresses.auction, isSigner: false, isWritable: true },
    { pubkey: BASE_MINT, isSigner: false, isWritable: false },
    { pubkey: QUOTE_MINT, isSigner: false, isWritable: false },
    { pubkey: addresses.vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: addresses.baseVault, isSigner: false, isWritable: true },
    { pubkey: addresses.quoteVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ]);
  return { ...addresses, createTx: await sendFinalized(authority, [createIx]) };
}

async function placeOrder({ auction, vaultAuthority, baseVault, quoteVault, owner, side, quantity }) {
  const baseAta = getAssociatedTokenAddressSync(BASE_MINT, owner.publicKey);
  const quoteAta = getAssociatedTokenAddressSync(QUOTE_MINT, owner.publicKey);
  const ix = await instruction(PROGRAM_ID, "place_order", [u8(side), u16(OPENING_REFERENCE_CENTS), u64(quantity)], [
    { pubkey: auction, isSigner: false, isWritable: true },
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: BASE_MINT, isSigner: false, isWritable: false },
    { pubkey: QUOTE_MINT, isSigner: false, isWritable: false },
    { pubkey: baseAta, isSigner: false, isWritable: true },
    { pubkey: quoteAta, isSigner: false, isWritable: true },
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: baseVault, isSigner: false, isWritable: true },
    { pubkey: quoteVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ]);
  return sendFinalized(owner, [ix]);
}

async function closeAuction(authority, auction) {
  const ix = await instruction(PROGRAM_ID, "close_auction", [], [
    { pubkey: auction, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
  ]);
  return sendFinalized(authority, [ix]);
}

function decodeState(accountInfo) {
  if (!accountInfo) return null;
  const data = accountInfo.data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8 + 32 * 5;
  offset += 8;
  const cutoffTime = view.getBigInt64(offset, true);
  offset += 8;
  offset += 8 + 2 + 2;
  const candidateTickCount = data[offset];
  const orderCount = data[offset + 1];
  const state = data[offset + 2];
  return { cutoffTime, candidateTickCount, orderCount, state };
}

async function closePreviousRoomIfNeeded(authority) {
  let room;
  try {
    room = JSON.parse(await readFile(ROOM_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!room?.auctionAddress || room.status !== "open") return;
  const auction = new PublicKey(room.auctionAddress);
  const account = await connection.getAccountInfo(auction, "finalized");
  const state = decodeState(account);
  if (!state || state.state !== 0) return;
  const chainSlot = await connection.getSlot("finalized");
  const chainTime = await connection.getBlockTime(chainSlot);
  invariant(Number.isSafeInteger(chainTime), "Could not read finalized devnet time.");
  invariant(Number(state.cutoffTime) <= chainTime, "The existing public Auction Room is still open.");
  const closeTx = await closeAuction(authority, auction);
  process.stdout.write("Closed previous room: " + closeTx.explorerUrl + "\n");
}

async function main() {
  await mkdir(KEY_DIR, { recursive: true, mode: 0o700 });
  const authority = await loadKeypair("authority");
  const buyer = await loadKeypair("buyer");
  const seller = await loadKeypair("seller");
  const [baseInfo, quoteInfo] = await Promise.all([
    getMint(connection, BASE_MINT, "finalized"),
    getMint(connection, QUOTE_MINT, "finalized"),
  ]);
  invariant(baseInfo.decimals === 2 && quoteInfo.decimals === 6, "The devnet test mint decimals changed.");
  invariant(baseInfo.mintAuthority?.equals(authority.publicKey) && quoteInfo.mintAuthority?.equals(authority.publicKey),
    "The devnet test mints are not controlled by the configured authority.");
  await closePreviousRoomIfNeeded(authority);
  const slot = await connection.getSlot("finalized");
  const chainTime = await connection.getBlockTime(slot);
  invariant(Number.isSafeInteger(chainTime), "Could not read finalized devnet time.");
  const auctionId = BigInt(Date.now());
  const cutoffTime = chainTime + CUTOFF_SECONDS;
  const created = await createAuction(authority, auctionId, cutoffTime);
  const seededBuy = await placeOrder({
    ...created,
    owner: buyer,
    side: 0,
    quantity: 200,
  });
  const seededSell = await placeOrder({
    ...created,
    owner: seller,
    side: 1,
    quantity: 200,
  });
  const room = {
    status: "open",
    network: "devnet",
    programId: PROGRAM_ID.toBase58(),
    distributorAuthority: authority.publicKey.toBase58(),
    auctionAddress: created.auction.toBase58(),
    auctionId: String(auctionId),
    createdAt: new Date(chainTime * 1000).toISOString(),
    cutoffTime: new Date(cutoffTime * 1000).toISOString(),
    mints: {
      base: {
        name: "DEMO-EQUITY",
        address: BASE_MINT.toBase58(),
        decimals: 2,
        disclosure: "Solana devnet test asset with no PreStocks backing or monetary value.",
      },
      quote: {
        name: "DEMO-USD",
        address: QUOTE_MINT.toBase58(),
        decimals: 6,
        disclosure: "Solana devnet test asset with no PreStocks backing or monetary value.",
      },
    },
    caps: {
      maxOrders: MAX_ORDERS,
      seededOrders: 2,
      visitorOrderCapacity: MAX_ORDERS - 2,
    },
    seededOrders: {
      description: "Disclosed test counterparty orders, not organic liquidity or evidence of better execution.",
      transactions: [
        { label: "Create auction", ...created.createTx },
        { label: "Seed test buy", ...seededBuy },
        { label: "Seed test sell", ...seededSell },
      ],
    },
    solFunding: {
      mode: "faucet",
      url: "https://faucet.solana.com/",
      note: "A wallet needs devnet SOL for fees and token-account rent.",
    },
  };
  await writeFile(ROOM_PATH, JSON.stringify(room, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify(room, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write((error?.stack ?? error?.message ?? String(error)) + "\n");
  process.exitCode = 1;
});
