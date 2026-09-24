export const PRESTOCKS_API = "https://prestocks.com/api/prestocks";
export const KALSHI_PRODUCT = "https://prestocks.com/kalshi";
export const KALSHI_MINT = "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
export const JUPITER_ORDER = "https://api.jup.ag/swap/v2/order";

const REQUEST_TIMEOUT_MS = 12_000;

function observedAt() {
  return new Date().toISOString();
}

function unavailable(source, reason, time = observedAt(), fields = {}) {
  return { status: "unavailable", source, observedAt: time, reason, ...fields };
}

async function responseJson(response, sourceName) {
  if (!response.ok) throw new Error(`${sourceName} returned HTTP ${response.status}`);
  return response.json();
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRecord(item) {
  if (!item || typeof item !== "object") return null;
  const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
  const mint = typeof item.contract_address === "string" ? item.contract_address.trim() : "";
  const issuerUrl = typeof item.external_url === "string" ? item.external_url : "";
  let issuer;
  try {
    issuer = new URL(issuerUrl);
  } catch {
    return null;
  }
  if (!/^[A-Z0-9]+$/.test(symbol) || !/^[A-Za-z0-9]{32,48}$/.test(mint)
    || issuer.protocol !== "https:" || !["prestocks.com", "www.prestocks.com"].includes(issuer.hostname)) {
    return null;
  }
  return {
    name: typeof item.name === "string" ? item.name : `${symbol} PreStocks`,
    symbol,
    description: typeof item.description === "string" ? item.description : null,
    issuerUrl,
    mint,
    markPrice: finiteNumber(item.markPrice),
    tokenPrice: finiteNumber(item.tokenPrice),
    supply: finiteNumber(item.supply),
  };
}

export async function getPreStocksCatalog(fetchImpl = fetch) {
  const time = observedAt();
  try {
    const response = await fetchImpl(PRESTOCKS_API, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const records = await responseJson(response, "PreStocks API");
    if (!Array.isArray(records)) return unavailable(PRESTOCKS_API, "The official API response was not a product list", time);
    const products = records.map(normalizeRecord).filter(Boolean);
    if (!products.length) return unavailable(PRESTOCKS_API, "The official API did not return verified PreStocks records", time);
    return { status: "available", source: PRESTOCKS_API, observedAt: time, products };
  } catch (error) {
    return unavailable(PRESTOCKS_API, explainRequestError(error, "PreStocks API"), time);
  }
}

async function getVerifiedRecord({ symbol, mint }, fetchImpl) {
  const catalog = await getPreStocksCatalog(fetchImpl);
  if (catalog.status !== "available") return catalog;
  if (!symbol || !mint) {
    return unavailable(PRESTOCKS_API, "A verified product symbol and mint are required", catalog.observedAt, { symbol: symbol ?? null, mint: mint ?? null });
  }
  const record = catalog.products.find((product) => product.symbol === symbol);
  if (!record) {
    return unavailable(PRESTOCKS_API, `The selected symbol ${symbol} was not returned by the official PreStocks API`, catalog.observedAt, { symbol, mint });
  }
  if (record.mint !== mint) {
    return unavailable(PRESTOCKS_API, `The selected mint did not match the official ${symbol} record`, catalog.observedAt, { symbol, mint, expectedMint: record.mint });
  }
  return { status: "available", source: PRESTOCKS_API, observedAt: catalog.observedAt, record };
}

export async function getKalshiRecord(fetchImpl = fetch) {
  const catalog = await getPreStocksCatalog(fetchImpl);
  if (catalog.status !== "available") {
    if (catalog.reason === "The official API did not return verified PreStocks records") {
      return unavailable(PRESTOCKS_API, "The official API did not return a KALSHI record", catalog.observedAt);
    }
    return catalog;
  }
  const record = catalog.products.find((product) => product.symbol === "KALSHI");
  if (!record) return unavailable(PRESTOCKS_API, "The official API did not return a KALSHI record", catalog.observedAt);
  if (record.mint !== KALSHI_MINT) {
    return unavailable(PRESTOCKS_API, `The KALSHI contract address did not match the approved mint ${KALSHI_MINT}`, catalog.observedAt);
  }
  return {
    status: "available",
    source: PRESTOCKS_API,
    observedAt: catalog.observedAt,
    productUrl: record.issuerUrl === KALSHI_PRODUCT ? record.issuerUrl : KALSHI_PRODUCT,
    record: {
      name: record.name,
      symbol: record.symbol,
      mint: record.mint,
      markPrice: record.markPrice,
      tokenPrice: record.tokenPrice,
      supply: record.supply,
      description: record.description,
    },
  };
}

function explainRequestError(error, sourceName) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return `${sourceName} request timed out`;
  if (error?.cause?.code) return `${sourceName} network error (${error.cause.code})`;
  return error instanceof Error ? error.message : `${sourceName} request failed`;
}

function parseAmountToRaw(amount, decimals) {
  const value = String(amount ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new RangeError("Enter a positive decimal amount");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new RangeError(`Amount supports at most ${decimals} decimal places`);
  const scale = 10n ** BigInt(decimals);
  const raw = BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (raw <= 0n) throw new RangeError("Amount must be greater than zero");
  return raw.toString();
}

function formatRawAmount(rawValue, decimals) {
  if (typeof rawValue !== "string" || !/^\d+$/.test(rawValue)) throw new TypeError("Quote output amount was not a raw integer");
  const raw = BigInt(rawValue);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function getMintDecimals(mint, fetchImpl) {
  const response = await fetchImpl(MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenSupply",
      params: [mint, { commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await responseJson(response, "Solana mainnet RPC");
  if (payload.error) throw new Error(`Solana mainnet RPC returned ${payload.error.message ?? "an error"}`);
  const decimals = payload.result?.value?.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Solana mainnet RPC did not return valid selected mint decimals");
  }
  return decimals;
}

function providerFailureType(status, bodyText, error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError" || status === 408 || status === 504) return "timeout";
  const text = String(bodyText ?? "").toLowerCase();
  if (text.includes("no route") || text.includes("route not found") || text.includes("not tradable") || text.includes("could not find route")) return "no-route";
  if (status === 401 || status === 403) return "authorization";
  if (status === 429 || text.includes("too many requests")) return "rate-limit";
  return "provider-failure";
}

function providerFailureMessage(status, bodyText, error, apiKeyConfigured) {
  if (error) return explainRequestError(error, "Quote check");
  try {
    const body = JSON.parse(bodyText);
    if (body.error || body.message) return String(body.error ?? body.message);
  } catch {}
  if (status === 401 || status === 403) {
    return apiKeyConfigured
      ? `Jupiter returned HTTP ${status}; the configured API key was rejected`
      : `Jupiter returned HTTP ${status}; configure JUPITER_API_KEY to request this quote`;
  }
  if (status === 429) return "Jupiter rate limit reached; try again later";
  return `Jupiter returned HTTP ${status}`;
}

export async function getPreStocksQuote({ symbol, mint, side, amount }, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey ?? process.env.JUPITER_API_KEY ?? "";
  const requestTime = observedAt();
  const baseUnavailable = (reason, fields = {}) => unavailable(JUPITER_ORDER, reason, observedAt(), {
    symbol: symbol ?? null,
    mint: mint ?? null,
    direction: side ?? null,
    inputAmount: String(amount ?? ""),
    ...fields,
  });
  if (side !== "buy" && side !== "sell") return baseUnavailable("Direction must be buy or sell", { failureType: "invalid-input" });

  const verified = await getVerifiedRecord({ symbol, mint }, fetchImpl);
  if (verified.status !== "available") return baseUnavailable(verified.reason, { failureType: "market-validation", expectedMint: verified.expectedMint ?? null });
  const record = verified.record;
  const inputMint = side === "buy" ? USDC_MINT : record.mint;
  const outputMint = side === "buy" ? record.mint : USDC_MINT;
  const unavailableForRecord = (reason, fields = {}) => baseUnavailable(reason, {
    inputMint,
    outputMint,
    issuerUrl: record.issuerUrl,
    productName: record.name,
    failureType: fields.failureType ?? "unavailable",
    ...fields,
  });

  try {
    const selectedDecimals = await getMintDecimals(record.mint, fetchImpl);
    const inputDecimals = side === "buy" ? 6 : selectedDecimals;
    const outputDecimals = side === "buy" ? selectedDecimals : 6;
    let inputAmountRaw;
    try {
      inputAmountRaw = parseAmountToRaw(amount, inputDecimals);
    } catch (error) {
      return unavailableForRecord(error instanceof Error ? error.message : "Invalid quote amount", { failureType: "invalid-input" });
    }
    const requestUrl = new URL(JUPITER_ORDER);
    requestUrl.searchParams.set("inputMint", inputMint);
    requestUrl.searchParams.set("outputMint", outputMint);
    requestUrl.searchParams.set("amount", inputAmountRaw);
    const headers = apiKey ? { "x-api-key": apiKey } : {};
    let response;
    let bodyText = "";
    try {
      response = await fetchImpl(requestUrl, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      bodyText = await response.text();
    } catch (error) {
      return unavailableForRecord(providerFailureMessage(null, "", error, Boolean(apiKey)), { failureType: providerFailureType(null, "", error) });
    }
    if (!response.ok) {
      return unavailableForRecord(providerFailureMessage(response.status, bodyText, null, Boolean(apiKey)), {
        failureType: providerFailureType(response.status, bodyText),
      });
    }
    let quote;
    try {
      quote = JSON.parse(bodyText);
    } catch {
      return unavailableForRecord("Jupiter returned a non-JSON response", { failureType: "provider-failure" });
    }
    if (quote.transaction !== null && quote.transaction !== undefined) {
      return unavailableForRecord("The takerless request unexpectedly returned transaction data; the response was discarded", { failureType: "transaction-bearing-response" });
    }
    if (quote.inputMint !== inputMint || quote.outputMint !== outputMint) {
      return unavailableForRecord("Jupiter returned input or output mints that did not match the verified request", {
        failureType: "mint-mismatch",
        returnedInputMint: quote.inputMint ?? null,
        returnedOutputMint: quote.outputMint ?? null,
      });
    }
    if (quote.inAmount !== inputAmountRaw || typeof quote.outAmount !== "string" || !/^\d+$/.test(quote.outAmount)) {
      return unavailableForRecord("Jupiter did not return a complete quote for the requested amount", { failureType: "incomplete-quote" });
    }
    const inputAmount = String(amount);
    const outputAmount = formatRawAmount(quote.outAmount, outputDecimals);
    const effectivePriceUsdPerToken = side === "buy"
      ? Number(inputAmount) / Number(outputAmount)
      : Number(outputAmount) / Number(inputAmount);
    const fee = quote.platformFee && typeof quote.platformFee === "object" ? quote.platformFee : null;
    return {
      status: "available",
      source: JUPITER_ORDER,
      observedAt: observedAt(),
      requestObservedAt: requestTime,
      symbol: record.symbol,
      productName: record.name,
      mint: record.mint,
      issuerUrl: record.issuerUrl,
      direction: side,
      inputAmount,
      inputAmountRaw,
      outputAmount,
      outputAmountRaw: quote.outAmount,
      effectivePriceUsdPerToken,
      inputMint,
      outputMint,
      inputDecimals,
      outputDecimals,
      returnedInputMint: quote.inputMint,
      returnedOutputMint: quote.outputMint,
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
    return unavailableForRecord(explainRequestError(error, "Quote check"), { failureType: providerFailureType(null, "", error) });
  }
}

export async function getKalshiQuote({ side, amount }, options = {}) {
  return getPreStocksQuote({ symbol: "KALSHI", mint: KALSHI_MINT, side, amount }, options);
}
