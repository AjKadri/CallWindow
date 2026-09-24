export function filterMarketProducts(products, search = "") {
  const needle = String(search).trim().toLowerCase();
  if (!needle) return products.slice();
  return products.filter((product) => [product.symbol, product.name, product.issuerUrl, product.description]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle)));
}

export function resolveMarketSelection(products, { search = "", selectedSymbol = null } = {}) {
  const matches = filterMarketProducts(products, search);
  const selected = matches.find((product) => product.symbol === selectedSymbol) ?? matches[0] ?? null;
  return {
    matches,
    selected,
    selectedSymbol: selected?.symbol ?? null,
    noResults: matches.length === 0,
  };
}

export function quoteFormCopy(side, symbol = "selected token") {
  const selling = side === "sell";
  return {
    amountLabel: selling ? `Amount of ${symbol} to sell` : "Amount to spend (USDC)",
    unit: selling ? symbol : "USDC",
    limitLabel: selling ? "Minimum price per token (optional)" : "Maximum price per token (optional)",
    limitHelp: "This is the price for one full token, separate from the total amount spent or sold.",
  };
}
