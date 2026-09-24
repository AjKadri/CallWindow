import assert from "node:assert/strict";
import test from "node:test";
import { createCallWindowServer } from "../src/server/app.mjs";
import {
  JUPITER_ORDER,
  KALSHI_MINT,
  MAINNET_RPC,
  PRESTOCKS_API,
  USDC_MINT,
} from "../src/server/market.mjs";

const record = {
  name: "Kalshi PreStocks",
  symbol: "KALSHI",
  description: "Official test record",
  contract_address: KALSHI_MINT,
  external_url: "https://prestocks.com/kalshi",
  markPrice: 881,
  tokenPrice: 837,
  supply: 904,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function withServer(callback) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.href === PRESTOCKS_API) return jsonResponse([record]);
    if (url.origin === new URL(MAINNET_RPC).origin) return jsonResponse({ result: { value: { decimals: 9 } } });
    if (url.href.startsWith(JUPITER_ORDER)) {
      return jsonResponse({
        transaction: null,
        inputMint: url.searchParams.get("inputMint"),
        outputMint: url.searchParams.get("outputMint"),
        inAmount: url.searchParams.get("amount"),
        outAmount: "115000000",
        router: "metis",
      });
    }
    throw new Error(`Unexpected upstream request ${url.href}`);
  };
  const server = createCallWindowServer({ fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("server validates the selected mint before requesting a Jupiter quote", async () => {
  await withServer(async (origin, requests) => {
    const valid = await fetch(`${origin}/api/quote?symbol=KALSHI&mint=${KALSHI_MINT}&side=buy&amount=100`);
    const validBody = await valid.json();
    assert.equal(valid.status, 200);
    assert.equal(validBody.status, "available");
    assert.equal(validBody.inputMint, USDC_MINT);
    assert.equal(validBody.outputMint, KALSHI_MINT);

    const beforeInvalid = requests.filter(({ url }) => url.href.startsWith(JUPITER_ORDER)).length;
    const wrong = await fetch(`${origin}/api/quote?symbol=KALSHI&mint=B6ZoEr92PB58bN1MgTXwjZHBUxCZ895ERVdhFJtSQFcP&side=buy&amount=100`);
    const wrongBody = await wrong.json();
    assert.equal(wrong.status, 200);
    assert.equal(wrongBody.status, "unavailable");
    assert.equal(wrongBody.failureType, "market-validation");
    assert.equal(requests.filter(({ url }) => url.href.startsWith(JUPITER_ORDER)).length, beforeInvalid);
  });
});
