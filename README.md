# CallWindow

CallWindow pairs a live, read-only PreStocks KALSHI record and exact-mint route check with a separate funded auction on Solana devnet. The auction uses DEMO-EQUITY and DEMO-USD test mints with no equity backing.

## Run the app

Use Node.js 24 or later. Run the server and Vite commands in separate terminals.

```sh
npm install
npm run server
npm run dev
```

Open the Vite address printed by `npm run dev`. The PreStocks record and Jupiter quote refresh independently. The quote is pinned to the approved mint and requires a successful on-chain decimal lookup and a live no-taker route. If either check fails, the quote panel reports it as unavailable with the reason.

## Verify the bounded auction

```sh
npm test
npm run bench:bounds
npm run demo:devnet
```

`demo:devnet` builds and deploys the program, creates separate authority, buyer, and seller wallets, and exercises cancellation, a matched partial fill, a no-cross refund, and the 32-order/101-tick maximum. Wallet keyfiles and the public proof manifest are stored under the ignored `target/devnet/` directory. The script requests devnet SOL from the public faucet as needed.

On a fresh checkout, `build:program` creates the ignored program keypair and synchronizes the Rust and Anchor program IDs before compiling. The runner checks that all three IDs still match before it contacts devnet.

Devnet transactions use only DEMO-EQUITY and DEMO-USD. They do not involve the KALSHI mint. A route quote is indicative and does not establish fillability, eligibility, execution, or auction benefit.
