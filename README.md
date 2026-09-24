# CallWindow

CallWindow pairs a live, read-only PreStocks KALSHI record and exact-mint route check with a separate bounded auction demo built for Solana devnet. The escrow-to-claim/refund path is verified on localnet using DEMO-EQUITY and DEMO-USD test mints with no equity backing. The program deployment is finalized on public devnet, but the complete public auction flow remains unverified.

The public devnet funding transfer evidence is limited to two finalized SOL transfers: [buyer transfer](https://explorer.solana.com/tx/2JoncJ6VDLieCHWN3qT1sSLB5jUKt4WiemuKG4qK9Zv9ANix5TGQSUc9sVU3hNpdJk8mqMVrwUwLkJt8F2uSq1Yj?cluster=devnet) for 0.01005 SOL and [seller transfer](https://explorer.solana.com/tx/62zaZd8z46PL4QnKbgYPRPDDgdkTDQGHUgn6rd7gM3oUuCTo1FKne6uqP9jo8zJm2xCtc63UdQ4kXsUENZvTu2Vs?cluster=devnet) for 0.01004 SOL. The refreshed fresh-deployment preflight passed with a 1.55 SOL authority target. The [TPU deployment transaction](https://explorer.solana.com/tx/5sXQmpydTLYg1GFujUT4B7e9UupZTGiXWzjuDtqmEz1MNVrRCenLK7CVBFDz2G1yiApZmtWKgBmmreuA7Zb5HaQs?cluster=devnet) finalized successfully for program `GxX6X6zZSQSuxEoTHPwaAmKCcpGRVRiB6ERANHzS7Eq9`, with ProgramData `GJp3fePPNETLxt3QGn6uyeaziFZKJMWGAhqQFaDK6sG5` and 288,048 bytes. The runner then hit public-RPC `fetch failed`/rate-limit errors during demo-account setup. No public devnet auction, claim, refund, close compute measurement, or final reconciliation is claimed.

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
