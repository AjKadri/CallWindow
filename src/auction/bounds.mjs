export const MAX_ORDERS = 32;
export const MAX_CANDIDATE_TICKS = 101;
export const PRICE_TICK_CENTS = 1;

export function validateAuctionBounds({ orderCount, candidateTickCount }) {
  if (!Number.isInteger(orderCount) || orderCount < 0) {
    throw new RangeError("Order count must be a non-negative integer");
  }
  if (!Number.isInteger(candidateTickCount) || candidateTickCount < 1) {
    throw new RangeError("Candidate tick count must be a positive integer");
  }
  if (orderCount > MAX_ORDERS) {
    throw new RangeError(`Order limit is ${MAX_ORDERS}`);
  }
  if (candidateTickCount > MAX_CANDIDATE_TICKS) {
    throw new RangeError(`Candidate price tick limit is ${MAX_CANDIDATE_TICKS}`);
  }
}

export function closingWorkUpperBound(orderCount = MAX_ORDERS, candidateTickCount = MAX_CANDIDATE_TICKS) {
  validateAuctionBounds({ orderCount, candidateTickCount });
  const eligibilityChecks = 2 * orderCount * candidateTickCount;
  const allocationSortChecks = 2 * (orderCount * (orderCount - 1)) / 2;
  const allocationWalkChecks = 2 * orderCount;
  return {
    orderCount,
    candidateTickCount,
    eligibilityChecks,
    allocationSortChecks,
    allocationWalkChecks,
    totalComparisonUpperBound: eligibilityChecks + allocationSortChecks + allocationWalkChecks,
  };
}
