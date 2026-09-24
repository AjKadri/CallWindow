export function normalizeProviderNetwork(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("devnet")) return "devnet";
  if (normalized.includes("mainnet")) return "mainnet-beta";
  if (normalized.includes("testnet")) return "testnet";
  return "unknown";
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

export function requireDevnetNetwork(network) {
  if (network?.status === "devnet") return { ok: true, reason: "" };
  if (network?.status && network.status !== "unknown") {
    return {
      ok: false,
      reason: "Phantom is connected to " + network.status + ". Switch Phantom to Solana Devnet, disconnect this site, then reconnect. CallWindow will not sign this transaction.",
    };
  }
  return {
    ok: false,
    reason: "Phantom's selected Solana network could not be verified. Switch Phantom to Solana Devnet, disconnect this site, then reconnect. CallWindow will not sign until the provider reports Devnet.",
  };
}

export function classifyDevnetSimulation({ err, logs = [] } = {}) {
  const diagnostic = [typeof err === "string" ? err : JSON.stringify(err ?? ""), ...logs].join(" ");
  if (/insufficient funds|insufficient lamports|rent[- ]exempt|rent exemption|account.*rent/i.test(diagnostic)) {
    return "Devnet preflight failed because this wallet may not have enough devnet SOL for account rent and fees. Fund the wallet from the Solana devnet faucet, then try again.";
  }
  if (/blockhash not found|block height exceeded|transaction expired/i.test(diagnostic)) {
    return "Devnet preflight became stale before signing. Try the action again.";
  }
  return "Devnet preflight failed before signing" + (diagnostic ? ": " + diagnostic : ".");
}

export function classifyDevnetProviderError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/network|cluster|mainnet|devnet/i.test(message)) {
    return "Phantom did not sign the devnet transaction. Confirm Phantom is set to Solana Devnet, disconnect this site, reconnect, and try again.";
  }
  return message || "Phantom did not sign the devnet transaction.";
}

export class DevnetPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "DevnetPreflightError";
  }
}

export async function signAfterDevnetPreflight(transaction, { simulate, send }) {
  let simulation;
  try {
    simulation = await simulate(transaction);
  } catch (error) {
    const logs = error?.logs ?? error?.data?.logs ?? [];
    if (logs.length || /insufficient funds|insufficient lamports|rent[- ]exempt|rent exemption/i.test(error?.message ?? "")) {
      throw new DevnetPreflightError(classifyDevnetSimulation({ err: error?.message, logs }));
    }
    throw new DevnetPreflightError("Devnet preflight could not run. Check the devnet RPC connection and try again.");
  }
  if (simulation?.value?.err) {
    throw new DevnetPreflightError(classifyDevnetSimulation(simulation.value));
  }
  return send(transaction);
}
