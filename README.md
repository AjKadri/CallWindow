# CallWindow

CallWindow is a market-specific scheduled-auction demo. The Demo reads current official PreStocks records as a read-only mainnet reference, then settles only named CallWindow test assets on Solana devnet. It never auctions a PreStocks mint or submits a mainnet transaction. The server also retains an optional no-taker Jupiter quote API for independent checks, outside the Demo flow.

The current official API can expose up to three supported products. The server verifies the official symbol and exact mainnet mint, then maps it to the matching Devnet test mint and shared `DEMO-USD` quote mint:

| Symbol | Official mainnet mint | CallWindow Devnet base mint |
| --- | --- | --- |
| KALSHI | `PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua` | `J9JEhzraKShKaY6o6Lidi3RKYTRD2G6USV7L5BXuSm5n` (`CW-KALSHI-TEST`) |
| OPENAI | `PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF` | `5enTWRqREUhrMrnbiobBxpBWkyd5CfLtaMHgfBb876Ar` (`CW-OPENAI-TEST`) |
| SPACEX | `PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh` | `HwjCQ5qQRGfQsknMRKT8Uc6iLU7XwzuNK9NSMtLmmUqc` (`CW-SPACEX-TEST`) |

SpaceX appears only when its current official PreStocks record matches the allowlist. Test assets have no issuer backing, rights, or monetary value. The fixed illustrative demo grid is `$19.50` to `$20.50` in one-cent ticks, with at most 32 funded orders and 101 candidate prices. It does not represent a PreStocks price. Seeded orders are disclosed test orders, not organic liquidity or evidence of better execution.

Each supported market has an isolated Demo URL such as `/demo/?market=KALSHI&auction=<devnet-auction-address>`. The legacy `/room/?auction=...` route redirects to Demo without inferring a PreStocks market from a generic auction address.

The public devnet funding transfer evidence includes the [buyer transfer](https://explorer.solana.com/tx/2JoncJ6VDLieCHWN3qT1sSLB5jUKt4WiemuKG4qK9Zv9ANix5TGQSUc9sVU3hNpdJk8mqMVrwUwLkJt8F2uSq1Yj?cluster=devnet) for 0.01005 SOL, the [seller transfer](https://explorer.solana.com/tx/62zaZd8z46PL4QnKbgYPRPDDgdkTDQGHUgn6rd7gM3oUuCTo1FKne6uqP9jo8zJm2xCtc63UdQ4kXsUENZvTu2Vs?cluster=devnet) for 0.01004 SOL, and the [20,000-lamport buyer top-up](https://explorer.solana.com/tx/YNyk8i3p153MjCT6AgzEc4u2ga36ekpWJBbiX1akbkUFBhzPWRjZNCc3cyg83ZbvBtNsC6oecrJvttdZPmssWTe?cluster=devnet) after recovery fees. The preflight target was 1.55 SOL for the authority, 0.01005 SOL for the buyer, and 0.01004 SOL for the seller. The executable [public devnet program account](https://explorer.solana.com/address/GxX6X6zZSQSuxEoTHPwaAmKCcpGRVRiB6ERANHzS7Eq9?cluster=devnet) is `GxX6X6zZSQSuxEoTHPwaAmKCcpGRVRiB6ERANHzS7Eq9`, with ProgramData `GJp3fePPNETLxt3QGn6uyeaziFZKJMWGAhqQFaDK6sG5` and 288,048 bytes.

The complete three-wallet historical devnet flow finalized once after bounded request pacing and `Retry-After` handling. It used the generic proof pair `DEMO-EQUITY` and `DEMO-USD`, without creating duplicate mints or accounts. The tracked proof file contains the public signatures, Explorer links, fees, claims, refunds, and final reconciliation. Close compute was 30,098 CU for the matched auction, 27,912 CU for no-cross, and 88,875 CU at 32 orders and 101 candidate ticks. Final balances were authority 1.94280484 SOL, buyer 0.010 SOL, and seller 0.010 SOL. All six demo vault balances were zero after claims and refunds.

## Public devnet proof

The verified close transactions are recorded in the tracked [`web/public/devnet-proof.json`](web/public/devnet-proof.json):

- [Matched close](https://explorer.solana.com/tx/3tMh5qoya4y1JJZC8K85wZzHP12tok8T2CtjPbTHNe8L3cu6L68xD1vNohaq3AzoVZt7qdwzXekJVqbXsUPoBiFm?cluster=devnet): 30,098 compute units, 5,000 lamports.
- [No-cross close](https://explorer.solana.com/tx/2kfe5TFFi6ibjSr1KXqjZWijChi4iKXver9eWDdch8U6LPNvPZJLJGAStj7ApaJ1ZJBMQjF7B4HbqLFqxpSVMGhZ?cluster=devnet): 27,912 compute units, 5,000 lamports.
- [32-order, 101-tick close](https://explorer.solana.com/tx/3MfJ6HnuJdFFEELhRLXwKMEdkb3mJtCEMGaN94BMvcEFLsUJCbUpY3oPJGy1ND5acr8pCg8ye1NFNFiwZmoYLQEq?cluster=devnet): 88,875 compute units, 5,000 lamports.

After claims and refunds, matched base/quote, no-cross base/quote, and maximum base/quote vaults were each `0` units.

## Run the app

Use Node.js 24 or later. Run the server and Vite commands in separate terminals.

```sh
npm install
npm run server
npm run dev
```

Open the Vite address printed by `npm run dev`. The Demo first verifies the selected official PreStocks record and exact mainnet mint, then loads that product's isolated Devnet test window. If the official record or its matching test window is unavailable, the Demo says so and keeps the auction controls unavailable.

## Provision market windows

Each market window is created with its allowlisted Devnet base mint and shared `DEMO-USD`. The operator keeps the authority and seed-wallet keyfiles outside Git, then writes the ignored `target/devnet/market-rooms.json` manifest used by the server. A clean checkout without that manifest shows an honest unavailable state.

```sh
CALLWINDOW_CLUSTER=devnet \
CALLWINDOW_MARKET_SYMBOL=KALSHI \
CALLWINDOW_BASE_MINT=J9JEhzraKShKaY6o6Lidi3RKYTRD2G6USV7L5BXuSm5n \
CALLWINDOW_BASE_NAME=CW-KALSHI-TEST \
CALLWINDOW_MARKET_ROOMS_PATH=target/devnet/market-rooms.json \
npm run auction:open
```

Use the matching allowlisted base mint and name for `OPENAI` or `SPACEX`. The distributor is server-side, devnet-only, and capped at up to 2 claims per wallet and 50 total claims. Its ignored version-3 ledger records a signed transaction identity before broadcast, reconciles uncertain attempts, and uses a shared process lock. Unresolved attempts occupy cap slots and fail closed. Wallets still need Devnet SOL for fees and token-account rent. Use the [Solana Devnet faucet](https://faucet.solana.com/). Never put the distributor key or runtime manifest in the browser or repository. The public claim endpoint does not yet prove control of the recipient wallet, so the cap does not remove Sybil risk.

## Verify the bounded auction

To run the three-wallet flow on a local validator first, start it in a separate terminal:

```sh
.tools/solana/active_release/bin/solana-test-validator --reset --ledger target/localnet-ledger --quiet
npm run demo:localnet
```

For public devnet, use the selected finalized demo mints when resuming the deployed program:

```sh
npm test
npm run bench:bounds
CALLWINDOW_CLUSTER=devnet \
CALLWINDOW_BASE_MINT=B6ZoEr92PB58bN1MgTXwjZHBUxCZ895ERVdhFJtSQFcP \
CALLWINDOW_QUOTE_MINT=7gLQ8vdtYTxbHa4YK9gjjsVe49WiKeH6pi2pV8us8zd4 \
CALLWINDOW_CUTOFF_SECONDS=240 npm run demo:devnet
```

Both demo commands build the program, use separate authority, buyer, and seller wallets, and exercise cancellation, a matched partial fill, a no-cross refund, and the 32-order/101-tick maximum. Localnet and devnet keyfiles and proof manifests are isolated under their respective ignored `target/localnet/` and `target/devnet/` directories. Localnet funding uses only the local validator faucet. Devnet runs check finalized wallet balances and stop if any wallet is underfunded; they do not request SOL from the public RPC faucet. An existing executable devnet deployment is reused rather than redeployed.

The devnet preflight calculates the authority target from the built program size, current finalized rent-exemption values for the upgradeable-loader and auction accounts, a deployment write-fee estimate checked against local deployment fees, observed authority transaction fees, and a 0.03 SOL reserve. A fresh deployment uses the larger of its buffer and persistent program-account rent peaks. An upgrade adds only any missing persistent rent and includes a temporary buffer rent. Deployment reconciliation measures changes in Program and ProgramData lamports, so a repeat upgrade does not count existing rent as a new cost. The buyer and seller targets include their measured local transaction fees and a 0.01 SOL reserve each.

On a fresh checkout, `build:program` creates the ignored program keypair and synchronizes the Rust and Anchor program IDs before compiling. The runner checks that all three IDs still match before it contacts devnet.

Devnet transactions use only the selected CallWindow test base mint and shared DEMO-USD. They do not involve a PreStocks mint. The optional route quote API is indicative and does not establish fillability, eligibility, execution, or auction benefit.
