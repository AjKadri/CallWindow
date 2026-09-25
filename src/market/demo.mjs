export const DEMO_QUOTE_MINT = "7gLQ8vdtYTxbHa4YK9gjjsVe49WiKeH6pi2pV8us8zd4";

export const DEMO_MARKET_ALLOWLIST = Object.freeze({
  KALSHI: Object.freeze({
    symbol: "KALSHI",
    mainnetMint: "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua",
    testMint: "J9JEhzraKShKaY6o6Lidi3RKYTRD2G6USV7L5BXuSm5n",
    testName: "CW-KALSHI-TEST",
    testDecimals: 2,
    quoteMint: DEMO_QUOTE_MINT,
    quoteName: "DEMO-USD",
  }),
  OPENAI: Object.freeze({
    symbol: "OPENAI",
    mainnetMint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
    testMint: "5enTWRqREUhrMrnbiobBxpBWkyd5CfLtaMHgfBb876Ar",
    testName: "CW-OPENAI-TEST",
    testDecimals: 2,
    quoteMint: DEMO_QUOTE_MINT,
    quoteName: "DEMO-USD",
  }),
  SPACEX: Object.freeze({
    symbol: "SPACEX",
    mainnetMint: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh",
    testMint: "HwjCQ5qQRGfQsknMRKT8Uc6iLU7XwzuNK9NSMtLmmUqc",
    testName: "CW-SPACEX-TEST",
    testDecimals: 2,
    quoteMint: DEMO_QUOTE_MINT,
    quoteName: "DEMO-USD",
  }),
});

export function getDemoMarketConfig(symbol) {
  return DEMO_MARKET_ALLOWLIST[String(symbol ?? "").toUpperCase()] ?? null;
}

export function supportedDemoSymbols() {
  return Object.keys(DEMO_MARKET_ALLOWLIST);
}

export function attachDemoMarket(record) {
  const config = getDemoMarketConfig(record?.symbol);
  if (!config || record.mint !== config.mainnetMint) return null;
  return {
    ...record,
    demo: {
      base: { name: config.testName, address: config.testMint, decimals: config.testDecimals },
      quote: { name: config.quoteName, address: config.quoteMint, decimals: 6 },
      grid: { firstTickCents: 1950, candidateTickCount: 101, openingReferenceCents: 2000 },
      disclosure: "Solana devnet test asset with no issuer backing, rights, or monetary value.",
    },
  };
}
