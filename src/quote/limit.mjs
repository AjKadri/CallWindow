export const MAX_QUOTE_AGE_SECONDS = 60;

export function evaluateQuoteLimit({ quote, side, limit, now = Date.now() }) {
  if (String(limit ?? "").trim() === "") {
    return { status: "not-set", reason: "limit-not-set" };
  }
  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
    return { status: "invalid", reason: "limit" };
  }
  if (side !== "buy" && side !== "sell") {
    return { status: "invalid", reason: "side" };
  }
  if (!quote || quote.status !== "available") {
    return { status: "unavailable", reason: "quote-unavailable" };
  }

  const observedAt = Date.parse(quote.observedAt ?? "");
  const ageSeconds = (now - observedAt) / 1000;
  if (!Number.isFinite(observedAt) || ageSeconds < 0 || ageSeconds > MAX_QUOTE_AGE_SECONDS) {
    return { status: "unavailable", reason: "quote-stale" };
  }

  const effectivePrice = Number(quote.effectivePriceUsdPerToken);
  if (!Number.isFinite(effectivePrice) || effectivePrice <= 0) {
    return { status: "unavailable", reason: "price-unavailable" };
  }

  const meets = side === "buy" ? effectivePrice <= numericLimit : effectivePrice >= numericLimit;
  return {
    status: "determined",
    meets,
    limit: numericLimit,
    effectivePrice,
    ageSeconds,
    message: `The quote ${meets ? "met" : "did not meet"} your limit when checked.`,
  };
}
