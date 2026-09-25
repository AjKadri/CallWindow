import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDevnetSimulation,
  classifyDevnetRequestFailure,
  classifyDevnetRequestKind,
  canSignDevnet,
  DevnetPreflightError,
  getInjectedWallets,
  isBlockhashFailure,
  isAuctionWindowFailure,
  normalizeProviderNetwork,
  readProviderNetwork,
  requireDevnetNetwork,
  signAfterDevnetPreflight,
  signAfterDevnetPreflightWithBlockhashRetry,
} from "../src/wallet/devnet.mjs";
import { creatorWindowState } from "../src/auction/room.mjs";

test("wallet network detection accepts reported devnet and rejects mainnet", async () => {
  assert.equal(normalizeProviderNetwork("devnet"), "devnet");
  assert.equal(normalizeProviderNetwork("mainnet-beta"), "mainnet-beta");
  assert.equal((await readProviderNetwork({ network: "devnet" })).status, "devnet");
  const wrong = requireDevnetNetwork(await readProviderNetwork({ network: "mainnet-beta" }), { walletName: "Phantom" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /Select Solana Devnet in Phantom/);
});

test("wallet selection names explicit Phantom and Solflare providers", () => {
  const phantom = { isPhantom: true, connect() {}, signTransaction() {} };
  const solflare = { isSolflare: true, connect() {}, signTransaction() {} };
  const wallets = getInjectedWallets({ phantom: { solana: phantom }, solflare });
  assert.deepEqual(wallets.map(({ id, name }) => ({ id, name })), [
    { id: "phantom", name: "Phantom" },
    { id: "solflare", name: "Solflare" },
  ]);
  assert.equal(canSignDevnet(wallets[0].provider), true);
  assert.equal(getInjectedWallets({ solana: { connect() {} } }).length, 0);
});

test("mocked Devnet provider unlocks the creator form", async () => {
  const provider = { network: "devnet" };
  const network = await readProviderNetwork(provider);
  const form = creatorWindowState({ walletKey: requireDevnetNetwork(network).ok });
  assert.equal(form.buttonText, "Create window account");
  assert.equal(form.buttonDisabled, false);
});

test("unknown provider network stays unreported with manual instructions", async () => {
  const status = await readProviderNetwork({ request: async () => { throw new Error("unsupported"); } });
  const requirement = requireDevnetNetwork(status, { walletName: "Solflare" });
  assert.equal(status.status, "unknown");
  assert.equal(requirement.ok, true);
  assert.equal(requirement.verified, false);
  assert.match(requirement.reason, /Solflare did not report/);
});

test("devnet preflight distinguishes insufficient rent from other failures", () => {
  const insufficient = classifyDevnetSimulation({ err: { InstructionError: [0, "InsufficientFunds"] }, logs: ["insufficient funds for rent"] });
  assert.match(insufficient, /not have enough devnet SOL/);
  const testAssetShortfall = classifyDevnetSimulation({
    err: { InstructionError: [2, { Custom: 1 }] },
    logs: [
      "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [1]",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
      "Program log: Error: insufficient funds",
    ],
  });
  assert.match(testAssetShortfall, /not have enough DEMO test assets/);
  assert.doesNotMatch(testAssetShortfall, /devnet SOL/);
  const ambiguous = classifyDevnetSimulation({ err: { InstructionError: [2, "InsufficientFunds"] } });
  assert.doesNotMatch(ambiguous, /devnet SOL|DEMO test assets/);
  const other = classifyDevnetSimulation({ err: { InstructionError: [0, "Custom"] }, logs: ["custom program failure"] });
  assert.match(other, /Devnet preflight failed before signing/);
  assert.doesNotMatch(other, /custom program failure/);
  const accountFailure = classifyDevnetSimulation({ err: { InstructionError: [0, "AccountNotFound"] }, logs: ["a program account was not found"] });
  assert.doesNotMatch(accountFailure, /not have enough devnet SOL/);
});

test("AuctionNotOpen remains distinct from funding failures", () => {
  const message = classifyDevnetSimulation({ err: { InstructionError: [0, { Custom: 6007 }] }, logs: ["Error Code: AuctionNotOpen"] });
  assert.match(message, /auction is no longer open/);
  assert.equal(isAuctionWindowFailure(Object.assign(new Error(message), { details: "custom program failure" })), true);
  assert.doesNotMatch(message, /raw|logs|custom program/);
});

test("camel-case BlockhashNotFound is classified and retried once before signing", async () => {
  assert.equal(isBlockhashFailure("BlockhashNotFound"), true);
  assert.match(classifyDevnetSimulation({ err: "BlockhashNotFound" }), /became stale/);
  let hashCalls = 0;
  let builds = 0;
  let simulations = 0;
  let sends = 0;
  const result = await signAfterDevnetPreflightWithBlockhashRetry({
    getLatestBlockhash: async () => ({ blockhash: `hash-${++hashCalls}`, lastValidBlockHeight: hashCalls }),
    buildTransaction: async (latest) => ({ recentBlockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, build: ++builds }),
    simulate: async (transaction) => {
      simulations += 1;
      return { value: { err: simulations === 1 ? "BlockhashNotFound" : null }, transaction };
    },
    send: async (transaction) => { sends += 1; return { signature: transaction.recentBlockhash }; },
  });
  assert.equal(hashCalls, 2);
  assert.equal(builds, 2);
  assert.equal(simulations, 2);
  assert.equal(sends, 1);
  assert.equal(result.result.signature, "hash-2");
});

test("Devnet request failures stay distinct and preserve browser diagnostics", async () => {
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND api.devnet.solana.com"), { code: "ENOTFOUND" });
  const rateLimit = Object.assign(new Error("Too Many Requests"), { status: 429 });
  const rpc = Object.assign(new Error("Invalid params"), { code: -32602 });
  const browser = new TypeError("Failed to fetch");
  assert.equal(classifyDevnetRequestKind(dns), "dns");
  assert.equal(classifyDevnetRequestKind(rateLimit), "rate-limit");
  assert.equal(classifyDevnetRequestKind(rpc), "rpc-rejection");
  assert.equal(classifyDevnetRequestKind(browser), "browser-network");
  assert.match(classifyDevnetRequestFailure(dns), /could not resolve/);
  assert.match(classifyDevnetRequestFailure(rateLimit), /rate-limited/);
  assert.match(classifyDevnetRequestFailure(rpc), /RPC rejected/);
  assert.match(classifyDevnetRequestFailure(browser), /could not reach/);
  await assert.rejects(
    signAfterDevnetPreflight({}, { simulate: async () => { throw browser; }, send: async () => { assert.fail("send must not run"); } }),
    (error) => error instanceof DevnetPreflightError
      && /could not reach/.test(error.message)
      && /name=TypeError; message=Failed to fetch/.test(error.details),
  );
});

test("transient Devnet RPC failure retries once before signing", async () => {
  let simulations = 0;
  let hashCalls = 0;
  let sends = 0;
  const result = await signAfterDevnetPreflightWithBlockhashRetry({
    getLatestBlockhash: async () => ({ blockhash: `retry-${++hashCalls}`, lastValidBlockHeight: hashCalls }),
    buildTransaction: async (latest) => latest,
    simulate: async () => {
      simulations += 1;
      if (simulations === 1) throw Object.assign(new Error("Too Many Requests"), { status: 429 });
      return { value: { err: null } };
    },
    send: async () => { sends += 1; return { signature: "retry-signature" }; },
  });
  assert.equal(hashCalls, 2);
  assert.equal(simulations, 2);
  assert.equal(sends, 1);
  assert.equal(result.result.signature, "retry-signature");
});

test("failed creator preflight leaves a visible retry state and never sends", async () => {
  let sends = 0;
  await assert.rejects(
    signAfterDevnetPreflight({}, {
      simulate: async () => ({ value: { err: { InstructionError: [0, "InsufficientFunds"] }, logs: ["insufficient funds for rent"] } }),
      send: async () => { sends += 1; },
    }),
    (error) => error instanceof DevnetPreflightError && /not have enough devnet SOL/.test(error.message),
  );
  assert.equal(sends, 0);
  const failed = creatorWindowState({
    walletKey: true,
    error: "Devnet simulation failed: wallet may not have enough devnet SOL.",
  });
  assert.equal(failed.buttonText, "Retry create window");
  assert.equal(failed.buttonDisabled, false);
  assert.match(failed.status, /Devnet simulation failed/);
});

test("successful devnet preflight reaches the mocked wallet send method", async () => {
  let simulations = 0;
  let sends = 0;
  const result = await signAfterDevnetPreflight({}, {
    simulate: async () => { simulations += 1; return { value: { err: null } }; },
    send: async () => { sends += 1; return { signature: "devnet-signature" }; },
  });
  assert.equal(simulations, 1);
  assert.equal(sends, 1);
  assert.equal(result.signature, "devnet-signature");
});
