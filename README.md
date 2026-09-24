# CallWindow

CallWindow pairs a live, read-only PreStocks KALSHI record and exact-mint route check with a separate bounded auction demo built for Solana devnet. The escrow-to-claim/refund path is verified on localnet using DEMO-EQUITY and DEMO-USD test mints with no equity backing. Public devnet deployment remains unverified pending funding.

## Run the app

Use Node.js 24 or later. Run the server and Vite commands in separate terminals.

```sh
npm install
npm run server
npm run dev
```

Open the Vite address printed by `npm run dev`. The PreStocks record and Jupiter quote refresh independently. The quote is pinned to the approved mint and requires a successful on-chain decimal lookup and a live no-taker route. If either check fails, the quote panel reports it as unavailable with the reason.

## Verify the bounded auction

To run the three-wallet flow on a local validator first, start it in a separate terminal:

```sh
.tools/solana/active_release/bin/solana-test-validator --reset --ledger target/localnet-ledger --quiet
npm run demo:localnet
```

For public devnet, run:

```sh
npm test
npm run bench:bounds
npm run demo:devnet
```

Both demo commands build and deploy the program, create separate authority, buyer, and seller wallets, and exercise cancellation, a matched partial fill, a no-cross refund, and the 32-order/101-tick maximum. Localnet and devnet keyfiles and proof manifests are isolated under their respective ignored `target/localnet/` and `target/devnet/` directories. Localnet funding uses only the local validator faucet. Devnet runs check finalized wallet balances and stop if any wallet is underfunded; they do not request SOL from the public RPC faucet.

The devnet preflight calculates the authority target from the built program size, current finalized rent-exemption values for the upgradeable-loader and auction accounts, a deployment write-fee estimate checked against local deployment fees, observed authority transaction fees, and a 0.03 SOL reserve. A fresh deployment uses the larger of its buffer and persistent program-account rent peaks. An upgrade adds only any missing persistent rent and includes a temporary buffer rent. Deployment reconciliation measures changes in Program and ProgramData lamports, so a repeat upgrade does not count existing rent as a new cost. The buyer and seller targets include their measured local transaction fees and a 0.01 SOL reserve each.

On a fresh checkout, `build:program` creates the ignored program keypair and synchronizes the Rust and Anchor program IDs before compiling. The runner checks that all three IDs still match before it contacts devnet.

Devnet transactions use only DEMO-EQUITY and DEMO-USD. They do not involve the KALSHI mint. A route quote is indicative and does not establish fillability, eligibility, execution, or auction benefit.
