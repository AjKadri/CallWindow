export const CREATOR_ESTIMATED_FEES_LAMPORTS = 10_000n;

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
}) {
  const [account, balanceLamports, auctionRent, tokenRent, ...ownerAccounts] = await Promise.all([
    connection.getAccountInfo(walletKey, "finalized"),
    connection.getBalance(walletKey, "finalized"),
    connection.getMinimumBalanceForRentExemption(auctionAccountSize, "finalized"),
    connection.getMinimumBalanceForRentExemption(tokenAccountSize, "finalized"),
    ...ownerTokenAccounts.map((address) => connection.getAccountInfo(address, "finalized")),
  ]);
  const missingOwnerAccounts = ownerAccounts.filter((accountInfo) => !accountInfo).length;
  const requiredLamports = BigInt(auctionRent)
    + BigInt(tokenRent) * BigInt(vaultTokenAccountCount + missingOwnerAccounts)
    + BigInt(estimatedFeesLamports);
  return evaluateDevnetFunding({
    accountExists: Boolean(account),
    balanceLamports,
    requiredLamports,
  });
}
