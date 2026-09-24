export const CREATOR_ESTIMATED_FEES_LAMPORTS = 10_000n;
export const CREATOR_CREATE_FEE_ESTIMATE_LAMPORTS = 5_000n;
export const CREATOR_OPENING_FEE_ESTIMATE_LAMPORTS = 5_000n;

export function creatorCostEstimate({
  auctionRentLamports,
  tokenRentLamports,
  missingOwnerAccounts,
  estimatedFeesLamports = CREATOR_ESTIMATED_FEES_LAMPORTS,
}) {
  const auctionRent = BigInt(auctionRentLamports);
  const tokenRent = BigInt(tokenRentLamports);
  const ownerTokenRent = tokenRent * BigInt(missingOwnerAccounts);
  const vaultTokenRent = tokenRent * 2n;
  const fees = BigInt(estimatedFeesLamports);
  return {
    auctionRentLamports: auctionRent,
    vaultTokenRentLamports: vaultTokenRent,
    ownerTokenRentLamports: ownerTokenRent,
    createRentLamports: auctionRent + vaultTokenRent,
    openingRentLamports: ownerTokenRent,
    estimatedFeesLamports: fees,
    createFeeEstimateLamports: CREATOR_CREATE_FEE_ESTIMATE_LAMPORTS,
    openingFeeEstimateLamports: CREATOR_OPENING_FEE_ESTIMATE_LAMPORTS,
    requiredLamports: auctionRent + vaultTokenRent + ownerTokenRent + fees,
  };
}

export function evaluateDevnetFunding({ accountExists, balanceLamports, requiredLamports }) {
  const balance = BigInt(balanceLamports);
  const required = BigInt(requiredLamports);
  const shortfall = balance < required ? required - balance : 0n;
  if (!accountExists) {
    return {
      status: "missing",
      accountExists: false,
      balanceLamports: balance,
      requiredLamports: required,
      shortfallLamports: required,
    };
  }
  if (balance < required) {
    return {
      status: "insufficient",
      accountExists: true,
      balanceLamports: balance,
      requiredLamports: required,
      shortfallLamports: shortfall,
    };
  }
  return {
    status: "sufficient",
    accountExists: true,
    balanceLamports: balance,
    requiredLamports: required,
    shortfallLamports: 0n,
  };
}

export async function readDevnetFunding({
  connection,
  walletKey,
  auctionAccountSize,
  tokenAccountSize,
  ownerTokenAccounts,
  vaultTokenAccountCount = 2,
  estimatedFeesLamports = CREATOR_ESTIMATED_FEES_LAMPORTS,
  phase = "create-and-opening",
}) {
  const [account, balanceLamports, auctionRent, tokenRent, ...ownerAccounts] = await Promise.all([
    connection.getAccountInfo(walletKey, "finalized"),
    connection.getBalance(walletKey, "finalized"),
    connection.getMinimumBalanceForRentExemption(auctionAccountSize, "finalized"),
    connection.getMinimumBalanceForRentExemption(tokenAccountSize, "finalized"),
    ...ownerTokenAccounts.map((address) => connection.getAccountInfo(address, "finalized")),
  ]);
  const missingOwnerAccounts = ownerAccounts.filter((accountInfo) => !accountInfo).length;
  const costs = creatorCostEstimate({
    auctionRentLamports: auctionRent,
    tokenRentLamports: tokenRent,
    missingOwnerAccounts,
    estimatedFeesLamports,
  });
  const requiredLamports = phase === "opening"
    ? costs.openingRentLamports + costs.openingFeeEstimateLamports
    : phase === "create"
      ? costs.createRentLamports + costs.createFeeEstimateLamports
      : costs.requiredLamports;
  return {
    ...evaluateDevnetFunding({
      accountExists: Boolean(account),
      balanceLamports,
      requiredLamports,
    }),
    costs,
    phase,
  };
}
