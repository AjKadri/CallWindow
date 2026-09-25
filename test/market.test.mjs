import assert from "node:assert/strict";
import test from "node:test";
import {
  getKalshiQuote,
  getKalshiRecord,
  getPreStocksCatalog,
  getPreStocksQuote,
  getSupportedDemoCatalog,
  getVerifiedDemoRecord,
  JUPITER_ORDER,
  KALSHI_MINT,
  MAINNET_RPC,
  PRESTOCKS_API,
  USDC_MINT,
} from "../src/server/market.mjs";

const kalshiRecord = {
  name: "Kalshi PreStocks",
  symbol: "KALSHI",
  contract_address: KALSHI_MINT,
  external_url: "https://prestocks.com/kalshi",
  markPrice: 885.05,
  tokenPrice: 860.78,
  supply: 904.86,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeMarketFetch({ record = kalshiRecord, decimals = 9, quoteStatus = 200, quote = {} } = {}) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.href === PRESTOCKS_API) {
      return jsonResponse(Array.isArray(record) ? record : record ? [record] : []);
    }
    if (url.origin === new URL(MAINNET_RPC).origin) {
      return jsonResponse({ result: { value: { decimals } } });
    }
    if (url.href.startsWith(JUPITER_ORDER)) {
      return jsonResponse({
        ...quote,
        inputMint: quote.inputMint ?? url.searchParams.get("inputMint"),
        outputMint: quote.outputMint ?? url.searchParams.get("outputMint"),
      }, quoteStatus);
    }
    throw new Error(`Unexpected request ${url.href}`);
  };
  return { fetchImpl, requests };
}

test("official PreStocks KALSHI record requires the approved exact mint", async () => {
  const { fetchImpl } = fakeMarketFetch();
  const result = await getKalshiRecord(fetchImpl);
  assert.equal(result.status, "available");
  assert.equal(result.record.symbol, "KALSHI");
  assert.equal(result.record.mint, KALSHI_MINT);
  assert.equal(result.source, PRESTOCKS_API);
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
});

test("catalog exposes verified official products without demo assets", async () => {
  const catalog = await getPreStocksCatalog(fakeMarketFetch().fetchImpl);
  assert.equal(catalog.status, "available");
  assert.equal(catalog.products[0].symbol, "KALSHI");
  assert.equal(catalog.products[0].mint, KALSHI_MINT);
  assert.equal(catalog.products[0].issuerUrl, "https://prestocks.com/kalshi");
  assert.notEqual(catalog.products[0].mint, "B6ZoEr92PB58bN1MgTXwjZHBUxCZ895ERVdhFJtSQFcP");
});

test("supported demo catalog includes only official products with an allowlisted mint", async () => {
  const records = [
    kalshiRecord,
    { ...kalshiRecord, symbol: "OPENAI", name: "OpenAI PreStocks", contract_address: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF", external_url: "https://prestocks.com/openai" },
    { ...kalshiRecord, symbol: "SPACEX", name: "SpaceX PreStocks", contract_address: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh", external_url: "https://prestocks.com/spacex" },
    { ...kalshiRecord, symbol: "UNSUPPORTED", contract_address: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB", external_url: "https://prestocks.com/unsupported" },
  ];
  const { fetchImpl } = fakeMarketFetch({ record: records });
  const catalog = await getSupportedDemoCatalog(fetchImpl);
  assert.deepEqual(catalog.products.map((product) => product.symbol), ["KALSHI", "OPENAI", "SPACEX"]);
  assert.equal(catalog.products.find((product) => product.symbol === "SPACEX").demo.base.name, "CW-SPACEX-TEST");
  const verified = await getVerifiedDemoRecord({ symbol: "OPENAI", mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF" }, fetchImpl);
  assert.equal(verified.status, "available");
  assert.equal(verified.record.demo.base.address, "5enTWRqREUhrMrnbiobBxpBWkyd5CfLtaMHgfBb876Ar");
});

test("selected symbol and mint must match the current official record", async () => {
  const { fetchImpl, requests } = fakeMarketFetch();
  const result = await getPreStocksQuote({
    symbol: "KALSHI",
    mint: "B6ZoEr92PB58bN1MgTXwjZHBUxCZ895ERVdhFJtSQFcP",
    side: "buy",
    amount: "100",
  }, { fetchImpl, apiKey: "secret-not-printed" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.failureType, "market-validation");
  assert.match(result.reason, /did not match the official KALSHI record/);
  assert.equal(requests.some(({ url }) => url.href.startsWith(JUPITER_ORDER)), false);
});

test("switching products binds the selected mint and preserves decimals", async () => {
  const alternateRecord = {
    ...kalshiRecord,
    name: "Anduril PreStocks",
    symbol: "ANDURIL",
    contract_address: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB",
    external_url: "https://prestocks.com/anduril",
  };
  const { fetchImpl, requests } = fakeMarketFetch({
    record: alternateRecord,
    decimals: 6,
    quote: { transaction: null, inAmount: "100000000", outAmount: "640000000", router: "metis" },
  });
  const result = await getPreStocksQuote({
    symbol: "ANDURIL",
    mint: alternateRecord.contract_address,
    side: "buy",
    amount: "100",
  }, { fetchImpl, apiKey: "secret-not-printed" });
  assert.equal(result.status, "available");
  assert.equal(result.symbol, "ANDURIL");
  assert.equal(result.inputDecimals, 6);
  assert.equal(result.outputDecimals, 6);
  assert.equal(result.outputAmount, "640");
  assert.equal(result.inputMint, USDC_MINT);
  assert.equal(result.outputMint, alternateRecord.contract_address);
  const request = requests.find(({ url }) => url.href.startsWith(JUPITER_ORDER));
  assert.equal(request.url.searchParams.get("outputMint"), alternateRecord.contract_address);
  assert.equal(request.init.headers["x-api-key"], "secret-not-printed");
});

test("missing or substituted KALSHI records fail closed", async () => {
  const missing = await getKalshiRecord(fakeMarketFetch({ record: null }).fetchImpl);
  assert.equal(missing.status, "unavailable");
  assert.match(missing.reason, /did not return a KALSHI/);

  const substituted = await getKalshiRecord(fakeMarketFetch({
    record: { ...kalshiRecord, contract_address: "SomeOtherMint11111111111111111111111111111" },
  }).fetchImpl);
  assert.equal(substituted.status, "unavailable");
  assert.match(substituted.reason, /did not match the approved mint/);
});

test("buy quote uses fixed USDC and exact KALSHI mints without a taker", async () => {
  const { fetchImpl, requests } = fakeMarketFetch({
    quote: {
      transaction: null,
      inAmount: "100000000",
      outAmount: "114015369",
      router: "dflow",
      feeBps: 10,
      feeMint: USDC_MINT,
      platformFee: { amount: "100000", feeBps: 10, feeMint: USDC_MINT },
    },
  });
  const result = await getKalshiQuote({ side: "buy", amount: "100" }, { fetchImpl, apiKey: "" });
  assert.equal(result.status, "available");
  assert.equal(result.direction, "buy");
  assert.equal(result.inputAmount, "100");
  assert.equal(result.inputAmountRaw, "100000000");
  assert.equal(result.inputMint, USDC_MINT);
  assert.equal(result.outputMint, KALSHI_MINT);
  assert.equal(result.outputAmount, "0.114015369");
  assert.equal(result.route, "dflow");
  assert.equal(result.fees.totalFeeBps, 10);
  assert.equal(result.fees.feeMint, USDC_MINT);
  assert.equal(result.fees.platformFeeAmountRaw, "100000");
  assert.equal(result.fees.platformFeeBps, 10);
  assert.equal(result.fees.platformFeeMint, USDC_MINT);
  assert.equal(result.transactionIncluded, false);
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  const request = requests.find(({ url }) => url.href.startsWith(JUPITER_ORDER));
  assert.equal(request.url.searchParams.get("inputMint"), USDC_MINT);
  assert.equal(request.url.searchParams.get("outputMint"), KALSHI_MINT);
  assert.equal(request.url.searchParams.get("amount"), "100000000");
  assert.equal(request.url.searchParams.has("taker"), false);
  assert.equal(requests.some(({ url }) => url.href === PRESTOCKS_API), true);
  assert.equal(request.init.headers?.["x-api-key"], undefined);
});

test("sell quote obtains mint precision and uses the exact KALSHI input mint", async () => {
  const { fetchImpl, requests } = fakeMarketFetch({
    quote: {
      transaction: null,
      inAmount: "1000000000",
      outAmount: "856995634",
      router: "metis",
      feeBps: 10,
      feeMint: USDC_MINT,
    },
  });
  const result = await getKalshiQuote({ side: "sell", amount: "1" }, { fetchImpl, apiKey: "" });
  assert.equal(result.status, "available");
  assert.equal(result.inputAmountRaw, "1000000000");
  assert.equal(result.inputMint, KALSHI_MINT);
  assert.equal(result.outputMint, USDC_MINT);
  assert.equal(result.outputAmount, "856.995634");
  const request = requests.find(({ url }) => url.href.startsWith(JUPITER_ORDER));
  assert.equal(request.url.searchParams.get("inputMint"), KALSHI_MINT);
  assert.equal(request.url.searchParams.get("outputMint"), USDC_MINT);
});

test("quote is unavailable when exact mint decimals cannot be verified", async () => {
  const result = await getKalshiQuote(
    { side: "buy", amount: "100" },
    { fetchImpl: fakeMarketFetch({ decimals: null }).fetchImpl, apiKey: "" },
  );
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /valid selected mint decimals/);
});

test("Jupiter authorization and rate-limit failures stay visible as unavailable", async () => {
  const unauthorized = await getKalshiQuote(
    { side: "buy", amount: "100" },
    { fetchImpl: fakeMarketFetch({ quoteStatus: 401 }).fetchImpl, apiKey: "" },
  );
  assert.equal(unauthorized.status, "unavailable");
  assert.match(unauthorized.reason, /configure JUPITER_API_KEY/);
  assert.equal(unauthorized.direction, "buy");
  assert.equal(unauthorized.inputAmount, "100");
  assert.equal(unauthorized.inputMint, USDC_MINT);

  const limited = await getKalshiQuote(
    { side: "sell", amount: "1" },
    { fetchImpl: fakeMarketFetch({ quoteStatus: 429 }).fetchImpl, apiKey: "" },
  );
  assert.equal(limited.status, "unavailable");
  assert.match(limited.reason, /rate limit/);
});

test("quote network failures keep attempted size and direction visible", async () => {
  const result = await getKalshiQuote(
    { side: "sell", amount: "1.25" },
    {
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.href === PRESTOCKS_API) return jsonResponse([kalshiRecord]);
        if (url.origin === new URL(MAINNET_RPC).origin) return jsonResponse({ result: { value: { decimals: 9 } } });
        if (url.href.startsWith(JUPITER_ORDER)) throw new Error("network timeout");
        throw new Error(`Unexpected request ${url.href}`);
      },
      apiKey: "",
    },
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.direction, "sell");
  assert.equal(result.inputAmount, "1.25");
  assert.equal(result.inputMint, KALSHI_MINT);
  assert.equal(result.outputMint, USDC_MINT);
  assert.match(result.reason, /network timeout/);
});

test("unavailable quotes distinguish no-route responses from timeouts", async () => {
  const noRoute = await getPreStocksQuote(
    { symbol: "KALSHI", mint: KALSHI_MINT, side: "buy", amount: "100" },
    { fetchImpl: fakeMarketFetch({ quoteStatus: 400, quote: { error: "No route found for this pair" } }).fetchImpl, apiKey: "" },
  );
  assert.equal(noRoute.status, "unavailable");
  assert.equal(noRoute.failureType, "no-route");

  const timeoutFetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.href === PRESTOCKS_API) return jsonResponse([kalshiRecord]);
    if (url.origin === new URL(MAINNET_RPC).origin) return jsonResponse({ result: { value: { decimals: 9 } } });
    if (url.href.startsWith(JUPITER_ORDER)) {
      const error = new Error("upstream timeout");
      error.name = "TimeoutError";
      throw error;
    }
    throw new Error(`Unexpected request ${url.href}`);
  };
  const timeout = await getPreStocksQuote(
    { symbol: "KALSHI", mint: KALSHI_MINT, side: "buy", amount: "100" },
    { fetchImpl: timeoutFetch, apiKey: "" },
  );
  assert.equal(timeout.status, "unavailable");
  assert.equal(timeout.failureType, "timeout");
});

test("Jupiter returned mints must match the selected product pair", async () => {
  const result = await getPreStocksQuote(
    { symbol: "KALSHI", mint: KALSHI_MINT, side: "buy", amount: "100" },
    {
      fetchImpl: fakeMarketFetch({
        quote: {
          transaction: null,
          inAmount: "100000000",
          outAmount: "115000000",
          inputMint: USDC_MINT,
          outputMint: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB",
        },
      }).fetchImpl,
      apiKey: "",
    },
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.failureType, "mint-mismatch");
  assert.match(result.reason, /did not match the verified request/);
});

test("transaction-bearing or incomplete Jupiter responses are discarded", async () => {
  const transaction = await getKalshiQuote(
    { side: "buy", amount: "100" },
    {
      fetchImpl: fakeMarketFetch({
        quote: { transaction: "should-not-be-returned", inAmount: "100000000", outAmount: "1" },
      }).fetchImpl,
      apiKey: "",
    },
  );
  assert.equal(transaction.status, "unavailable");
  assert.match(transaction.reason, /transaction data/);

  const incomplete = await getKalshiQuote(
    { side: "buy", amount: "100" },
    { fetchImpl: fakeMarketFetch({ quote: { transaction: null, inAmount: "100000000" } }).fetchImpl, apiKey: "" },
  );
  assert.equal(incomplete.status, "unavailable");
  assert.match(incomplete.reason, /complete quote/);
});

test("invalid quote sizes and directions do not reach Jupiter", async () => {
  const { fetchImpl, requests } = fakeMarketFetch();
  const invalidAmount = await getKalshiQuote({ side: "buy", amount: "1.0000001" }, { fetchImpl, apiKey: "" });
  assert.equal(invalidAmount.status, "unavailable");
  assert.match(invalidAmount.reason, /at most 6 decimal places/);
  assert.equal(requests.some(({ url }) => url.href.startsWith(JUPITER_ORDER)), false);

  const invalidSide = await getKalshiQuote({ side: "swap", amount: "1" }, { fetchImpl, apiKey: "" });
  assert.equal(invalidSide.status, "unavailable");
  assert.match(invalidSide.reason, /Direction must be buy or sell/);
});
