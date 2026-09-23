export const PRESTOCKS_API = "https://prestocks.com/api/prestocks";
export const KALSHI_PRODUCT = "https://prestocks.com/kalshi";
export const KALSHI_MINT = "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
export const JUPITER_ORDER = "https://api.jup.ag/swap/v2/order";

function observedAt() {
  return new Date().toISOString();
}

function unavailable(source, reason, time = observedAt()) {
  return { status: "unavailable", source, observedAt: time, reason };
}

async function responseJson(response, sourceName) {
  if (!response.ok) {
    throw new Error(`${sourceName} returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function getKalshiRecord(fetchImpl = fetch) {
  const time = observedAt();
  try {
    const response = await fetchImpl(PRESTOCKS_API, { signal: AbortSignal.timeout(12_000) });
    const records = await responseJson(response, "PreStocks API");
    if (!Array.isArray(records)) {
      return unavailable(PRESTOCKS_API, "The official API response was not a product list", time);
    }
    const record = records.find((item) => item?.symbol === "KALSHI");
    if (!record) {
      return unavailable(PRESTOCKS_API, "The official API did not return a KALSHI record", time);
    }
    if (record.contract_address !== KALSHI_MINT) {
      return unavailable(
        PRESTOCKS_API,
        `The KALSHI contract address did not match the approved mint ${KALSHI_MINT}`,
        time,
      );
    }
    return {
      status: "available",
      source: PRESTOCKS_API,
      observedAt: time,
      productUrl: record.external_url === KALSHI_PRODUCT ? record.external_url : KALSHI_PRODUCT,
      record: {
        name: record.name ?? null,
        symbol: record.symbol,
        mint: record.contract_address,
        markPrice: finiteNumber(record.markPrice),
        tokenPrice: finiteNumber(record.tokenPrice),
        supply: finiteNumber(record.supply),
        description: record.description ?? null,
      },
    };
  } catch (error) {
    return unavailable(PRESTOCKS_API, explainRequestError(error, "PreStocks API"), time);
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function explainRequestError(error, sourceName) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return `${sourceName} request timed out`;
  }
  if (error?.cause?.code) {
    return `${sourceName} network error (${error.cause.code})`;
  }
  return error instanceof Error ? error.message : `${sourceName} request failed`;
}

function parseAmountToRaw(amount, decimals) {
  const value = String(amount ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new RangeError("Enter a positive decimal amount");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new RangeError(`Amount supports at most ${decimals} decimal places`);
  }
  const scale = 10n ** BigInt(decimals);
  const raw = BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (raw <= 0n) {
    throw new RangeError("Amount must be greater than zero");
  }
  return raw.toString();
}

function formatRawAmount(rawValue, decimals) {
  if (typeof rawValue !== "string" || !/^\d+$/.test(rawValue)) {
    throw new TypeError("Quote output amount was not a raw integer");
  }
  const raw = BigInt(rawValue);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function getKalshiDecimals(fetchImpl) {
  const response = await fetchImpl(MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenSupply",
      params: [KALSHI_MINT, { commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await responseJson(response, "Solana mainnet RPC");
  if (payload.error) {
    throw new Error(`Solana mainnet RPC returned ${payload.error.message ?? "an error"}`);
  }
  const decimals = payload.result?.value?.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Solana mainnet RPC did not return valid KALSHI mint decimals");
  }
  return decimals;
}

function jupiterErrorMessage(status, apiKeyConfigured) {
  if (status === 401 || status === 403) {
    return apiKeyConfigured
      ? `Jupiter returned HTTP ${status}; the configured API key was rejected`
      : `Jupiter returned HTTP ${status}; configure JUPITER_API_KEY to request this quote`;
  }
  if (status === 429) return "Jupiter rate limit reached; try again later";
  return `Jupiter returned HTTP ${status}`;
}

export async function getKalshiQuote({ side, amount }, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey ?? process.env.JUPITER_API_KEY ?? "";
  const quoteTime = observedAt();
  const quoteUnavailable = (reason, time = observedAt()) => ({
    ...unavailable(JUPITER_ORDER, reason, time),
    direction: side,
    inputAmount: String(amount ?? ""),
    inputMint: side === "buy" ? USDC_MINT : side === "sell" ? KALSHI_MINT : null,
    outputMint: side === "buy" ? KALSHI_MINT : side === "sell" ? USDC_MINT : null,
  });
  if (side !== "buy" && side !== "sell") {
    return quoteUnavailable("Direction must be buy or sell", quoteTime);
  }

  try {
    const kalshiDecimals = await getKalshiDecimals(fetchImpl);
    const inputDecimals = side === "buy" ? 6 : kalshiDecimals;
    const outputDecimals = side === "buy" ? kalshiDecimals : 6;
    const inputAmount = parseAmountToRaw(amount, inputDecimals);
    const inputMint = side === "buy" ? USDC_MINT : KALSHI_MINT;
    const outputMint = side === "buy" ? KALSHI_MINT : USDC_MINT;
    const requestUrl = new URL(JUPITER_ORDER);
    requestUrl.searchParams.set("inputMint", inputMint);
    requestUrl.searchParams.set("outputMint", outputMint);
    requestUrl.searchParams.set("amount", inputAmount);
    const headers = apiKey ? { "x-api-key": apiKey } : {};
    const response = await fetchImpl(requestUrl, { headers, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) {
      return quoteUnavailable(jupiterErrorMessage(response.status, Boolean(apiKey)), observedAt());
    }
    const quote = await response.json();
    if (quote.transaction !== null && quote.transaction !== undefined) {
      return quoteUnavailable(
        "The takerless request unexpectedly returned transaction data; the response was discarded",
        observedAt(),
      );
    }
    if (quote.inAmount !== inputAmount || quote.outAmount === undefined) {
      return quoteUnavailable("Jupiter did not return a complete quote for the requested amount", observedAt());
    }
    const outputAmount = formatRawAmount(String(quote.outAmount), outputDecimals);
    const fee = quote.platformFee && typeof quote.platformFee === "object" ? quote.platformFee : null;
    return {
      status: "available",
      source: JUPITER_ORDER,
      observedAt: observedAt(),
      direction: side,
      inputAmount: String(amount),
      inputAmountRaw: inputAmount,
      inputMint,
      outputAmount,
      outputAmountRaw: String(quote.outAmount),
      outputMint,
      inputDecimals,
      outputDecimals,
      route: typeof quote.router === "string" ? quote.router : "not reported",
      mode: typeof quote.mode === "string" ? quote.mode : null,
      fees: {
        totalFeeBps: Number.isInteger(quote.feeBps) ? quote.feeBps : null,
        feeMint: typeof quote.feeMint === "string" ? quote.feeMint : null,
        platformFeeAmountRaw: typeof fee?.amount === "string" ? fee.amount : null,
        platformFeeBps: Number.isInteger(fee?.feeBps) ? fee.feeBps : null,
        platformFeeMint: typeof fee?.feeMint === "string" ? fee.feeMint : null,
      },
      transactionIncluded: false,
      quoteKind: "indicative, read-only, no taker",
      mintDecimalsSource: MAINNET_RPC,
    };
  } catch (error) {
    return quoteUnavailable(explainRequestError(error, "Quote check"), observedAt());
  }
}
