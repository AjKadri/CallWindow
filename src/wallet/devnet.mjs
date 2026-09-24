export function normalizeProviderNetwork(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("devnet")) return "devnet";
  if (normalized.includes("mainnet")) return "mainnet-beta";
  if (normalized.includes("testnet")) return "testnet";
  return "unknown";
}

function providerFor(value) {
  return value && typeof value === "object" ? value : null;
}

export function getInjectedWallets(windowObject = globalThis.window) {
  const wallets = [];
  const phantom = providerFor(windowObject?.phantom?.solana)
    ?? (windowObject?.solana?.isPhantom ? providerFor(windowObject.solana) : null);
  const solflare = providerFor(windowObject?.solflare?.solana ?? windowObject?.solflare)
    ?? (windowObject?.solana?.isSolflare ? providerFor(windowObject.solana) : null);
  if (typeof phantom?.connect === "function") wallets.push({ id: "phantom", name: "Phantom", provider: phantom });
  if (typeof solflare?.connect === "function" && solflare !== phantom) wallets.push({ id: "solflare", name: "Solflare", provider: solflare });
  return wallets;
}

export function canSignDevnet(provider) {
  return typeof provider?.signTransaction === "function";
}

function networkValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.network ?? value.chain ?? value.name ?? value.cluster ?? null;
}

export async function readProviderNetwork(provider) {
  const direct = networkValue(provider?.network)
    ?? networkValue(provider?.selectedNetwork)
    ?? networkValue(provider?.chain);
  if (direct) return { status: normalizeProviderNetwork(direct), reported: direct };
  if (typeof provider?.getNetwork === "function") {
    try {
      const reported = networkValue(await provider.getNetwork());
      if (reported) return { status: normalizeProviderNetwork(reported), reported };
    } catch {}
  }
  if (typeof provider?.request === "function") {
    try {
      const response = await provider.request({ method: "getNetwork" });
      const reported = networkValue(response);
      if (reported) return { status: normalizeProviderNetwork(reported), reported };
    } catch {}
  }
  return { status: "unknown", reported: null };
}

export function requireDevnetNetwork(network, { walletName = "Selected wallet" } = {}) {
  if (network?.status === "devnet") return { ok: true, verified: true, reason: "" };
  if (network?.status && network.status !== "unknown") {
    return {
      ok: false,
      verified: false,
      reason: `${walletName} reports ${network.status}. Select Solana Devnet in ${walletName}, disconnect this site, then reconnect. CallWindow will not sign this transaction.`,
    };
  }
  return {
    ok: true,
    verified: false,
    reason: `${walletName} did not report its selected Solana network. CallWindow will only simulate, submit, and confirm this transaction through Solana Devnet. Check that ${walletName} is set to Solana Devnet before signing.`,
  };
}

export function classifyDevnetSimulation({ err, logs = [] } = {}) {
  const diagnostic = [typeof err === "string" ? err : JSON.stringify(err ?? ""), ...logs].join(" ");
  if (/6007|AuctionNotOpen/i.test(diagnostic)) {
    return "Devnet preflight found that the auction is no longer open for this order.";
  }
  if (/6008|WindowClosed/i.test(diagnostic)) {
    return "Devnet preflight found that the order window reached its cutoff.";
  }
  if (/insufficient funds|insufficient lamports|rent[- ]exempt|rent exemption|account.*rent/i.test(diagnostic)) {
    return "Devnet preflight failed because this wallet may not have enough devnet SOL for account rent and fees. Fund the wallet from the Solana devnet faucet, then try again.";
  }
  if (/blockhash not found|block height exceeded|transaction expired/i.test(diagnostic)) {
    return "Devnet preflight became stale before signing. Try the action again.";
  }
  return "Devnet preflight failed before signing. Review the window state and try again.";
}

export function isAuctionWindowFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const details = error?.details ?? "";
  return /6007|6008|AuctionNotOpen|WindowClosed|no longer open|reached its cutoff/i.test(`${message} ${details}`);
}

export function classifyDevnetProviderError(error, { walletName = "Selected wallet" } = {}) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/insufficient funds|insufficient lamports|rent[- ]exempt|rent exemption|account.*rent/i.test(message)) {
    return "Devnet submission failed because this wallet may not have enough devnet SOL for account rent and fees. Fund the wallet from the Solana devnet faucet, then try again.";
  }
  if (/network|cluster|mainnet|devnet/i.test(message)) {
    return `${walletName} did not complete the Solana Devnet request. Check its selected network and reconnect, then try again.`;
  }
  return message || `${walletName} did not complete the Solana Devnet request.`;
}

export class DevnetPreflightError extends Error {
  constructor(message, { details = "" } = {}) {
    super(message);
    this.name = "DevnetPreflightError";
    this.details = details;
  }
}

function simulationDiagnostic({ err, logs = [] } = {}) {
  return [typeof err === "string" ? err : JSON.stringify(err ?? ""), ...logs].join(" ").trim();
}

export async function signAfterDevnetPreflight(transaction, { simulate, send }) {
  let simulation;
  try {
    simulation = await simulate(transaction);
  } catch (error) {
    const logs = error?.logs ?? error?.data?.logs ?? [];
    if (logs.length || /insufficient funds|insufficient lamports|rent[- ]exempt|rent exemption/i.test(error?.message ?? "")) {
      throw new DevnetPreflightError(classifyDevnetSimulation({ err: error?.message, logs }), {
        details: simulationDiagnostic({ err: error?.message, logs }),
      });
    }
    throw new DevnetPreflightError("Devnet preflight could not run. Check the devnet RPC connection and try again.");
  }
  if (simulation?.value?.err) {
    throw new DevnetPreflightError(classifyDevnetSimulation(simulation.value), {
      details: simulationDiagnostic(simulation.value),
    });
  }
  return send(transaction);
}
