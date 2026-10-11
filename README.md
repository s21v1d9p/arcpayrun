# Arc Payrun

[![CI](https://github.com/s21v1d9p/arcpayrun/actions/workflows/ci.yml/badge.svg)](https://github.com/s21v1d9p/arcpayrun/actions/workflows/ci.yml)

Arc Payrun is a small web app for paying several people in USDC at once on Arc. You paste a list of addresses and amounts, approve one transaction in your wallet, and get a receipt link that anyone can check against the chain.

I built it for grant programs, DAOs and small teams that pay contributors in batches and need a simple record of who was paid what.

- Live app: https://arcpayrun.vercel.app
- Demo video (1 min 21 s, captioned, no sound): https://arcpayrun.vercel.app/demo.mp4
- Receipt for the first mainnet payout: https://arcpayrun.vercel.app/?tx=0xc6a721b4541aad27bc28c6df4a34e916e7d58aa3b510f3e9373d8748ca9acb06

## Why Arc

On Arc, USDC is also the gas token, so the person paying only needs USDC in their wallet. Arc has deterministic finality, so once the transaction is confirmed the receipt is final. The contract pays everyone in one transaction and reverts the whole batch if a single transfer fails, so a payout never ends up half done.

## Deployments

| Network | Contract | Deployment | Example payout |
| --- | --- | --- | --- |
| Arc mainnet (5042) | [0xbC34...5A20](https://explorer.arc.io/address/0xbC34A2aF65dF1a21316Eb23dC6023139906d5A20) | [0x942a...a52f](https://explorer.arc.io/tx/0x942ae0e4b4c1b52fec68578a65c3734e53731232751c77a1484031041e18a52f) | [0xc6a7...cb06](https://explorer.arc.io/tx/0xc6a721b4541aad27bc28c6df4a34e916e7d58aa3b510f3e9373d8748ca9acb06) |
| Arc testnet (5042002) | [0xbC34...5A20](https://explorer.testnet.arc.io/address/0xbC34A2aF65dF1a21316Eb23dC6023139906d5A20) | [0x8d00...9789](https://explorer.testnet.arc.io/tx/0x8d0002e20840d28ed86c56e1d748394cde3c071e7c8ffef996f45c9917f99789) | [0x29d3...9c29](https://explorer.testnet.arc.io/tx/0x29d3703ef6f18f4a6fb6c5733ba51c826f8208872362e1520db12e1346999c29) |

Both contracts were deployed from the same account at nonce 0, which is why the address is the same on both networks. The source is verified on both Arc explorers. The mainnet runtime bytecode is identical to the testnet build, and the app checks this before it uses the contract. The contract is named ArcBatch, which was this project's earlier name. I kept that name because changing it would change the compiled bytecode, and it would no longer match the deployed and verified contract.

The first mainnet payout went through the live app and sent 0.01 USDC to two addresses. Both balances went up by exactly 0.01 USDC and the contract kept nothing. Gas was about 0.002 USDC, and deploying the contract cost about 0.006 USDC.

## How it works

1. Add recipients by hand or paste a CSV with `address,amount` lines. A header row is optional.
2. The app checks every address, rejects duplicates, allows at most 6 decimal places and caps the list at 25 recipients. It doesn't store the list.
3. Connect a wallet and click Review batch. The list is sent through this site's `/arc-rpc` proxy (or straight to Arc's public RPC if the proxy fails) for the gas estimate. Before you can confirm, the app checks that you are on Arc mainnet, that the contract address holds the expected contract code, and that your balance covers the total plus gas.
4. Your wallet signs one `pay(recipients, amounts)` call with the exact total.
5. The app only reports success after the receipt contains a matching `Paid` event for every recipient. The `?tx=0x...` link rebuilds the receipt from Arc RPC, so anyone who opens it sees the onchain data rather than something stored by the app.

Recipient addresses and amounts are public once the transaction is sent.

## Paying from a Safe

Teams that hold USDC in a Safe on Arc can run Arc Payrun as a Safe App:

1. Open the Safe in [Safe{Wallet}](https://app.safe.global) on Arc.
2. Go to Apps, choose "My custom apps", and add `https://arcpayrun.vercel.app`.
3. Open Arc Payrun from the Safe. It picks up the Safe address, so there is nothing to connect.
4. Add recipients, review the batch, and click Propose in Safe. The Safe owners sign and execute it in Safe{Wallet} as usual.

The Safe pays the total and the owner who executes the transaction pays the gas. Arc Payrun shows the receipt once the transaction runs, and the receipt link names the Safe as the payer. Safe{Wallet} stores the proposed transaction, including recipients and amounts, so the other owners can sign it. Arc Payrun remembers proposals that are still waiting, in this browser only, so the same payout is not proposed twice.

## Security notes

- The payout contract (`contracts/ArcBatch.sol`) has no owner, no upgrade path and no withdraw function, and it doesn't hold funds after a call.
- `msg.value` has to equal the sum of the amounts. If one transfer fails, every transfer in the batch is reverted.
- The app pins the runtime bytecode in `src/lib/contractCode.ts` and refuses to send payouts to, or show receipts from, an address with different code.
- The wallet has to be on chain 5042. Nothing is marked as paid if the account changes, the quote is stale, the signature is rejected, or the transaction is still pending or reverted. Once a transaction is submitted, the confirm button stays disabled so the same list can't be sent twice.
- Fee caps account for Arc's 20 Gwei minimum base fee plus the priority fee.
- EasyPrivacy blocks third-party requests to `arc.io` (`||arc.io^$third-party`), which breaks direct RPC calls for many people with ad blockers. The app sends RPC calls to a same-origin `/arc-rpc` proxy first and falls back to `https://rpc.mainnet.arc.io`.
- `vercel.json` sets basic security headers. Only the site itself and Safe{Wallet} (`app.safe.global`) can frame it, and `manifest.json` allows cross-origin reads so Safe{Wallet} can show the app's name and icon.
- Inside Safe{Wallet}, the Safe Apps SDK only accepts messages from `https://app.safe.global`, and it is loaded only when the page runs in a frame.

The tests cover every line of the contract and include recipients that reject payments, recipients that try to call back into the contract, a full 25-recipient batch, invalid input and receipts that don't match. The contract has not been audited. A recipient that rejects USDC, a blocklisted address or any transfer that Arc's value rules forbid will make the whole batch revert.

## Running it locally

You need Node.js 22.12+ or 24+.

```bash
npm ci
npm run check
npm run dev
```

`npm run check` compiles the contract, then runs the frontend tests, the Hardhat contract tests, the linter, the TypeScript build and the production build. `npx hardhat test nodejs --coverage` prints the contract coverage.

Payments stay disabled until `VITE_ARC_BATCH_ADDRESS` is set. To point a local build at the mainnet contract:

```bash
cp .env.example .env.local
npm run dev
```

The contract address is public and ends up in the browser bundle, so it isn't a secret.

## Deploying the contract

Use a wallet you control, and never put a private key or recovery phrase in this repo.

`deploy.html` is a small helper page that only runs on localhost and isn't part of the production build. It deploys the locally compiled contract through MetaMask, so the key stays in the wallet.

```bash
npm test
npm run dev
```

- Testnet: open `http://127.0.0.1:5173/deploy.html`, fund a test wallet from [Circle's faucet](https://faucet.circle.com/), deploy, then run the two-recipient test payout.
- Mainnet: open `http://127.0.0.1:5173/deploy.html?network=mainnet`. The page requires chain 5042, refuses to deploy if the compiled code doesn't match `src/lib/contractCode.ts`, and asks you to type `DEPLOY ON MAINNET` before it estimates gas. Send the first real payout from the main app.

To deploy from the command line instead, `scripts/deploy.ts` works with Hardhat's encrypted keystore: run `npx hardhat keystore set ARC_DEPLOYER_PRIVATE_KEY`, then `npx hardhat run scripts/deploy.ts --network arcTestnet` (or `arcMainnet`).

Mainnet gas is paid in real USDC on Arc. I moved USDC from Ethereum to Arc with [Arc Portal](https://portal.arc.io/), which uses Circle's CCTP. Check the fee, network and recipient before you sign.

## Hosting

The live app runs on Vercel's free Hobby plan. `vercel.json` adds the `/arc-rpc` rewrite and the security headers. Set `VITE_ARC_BATCH_ADDRESS` for production builds, then deploy. Other static hosts work through the direct RPC fallback, but people with ad blockers may need a proxy like this one.

Arc docs I used: [RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints), [EVM differences](https://docs.arc.io/arc/references/evm-differences), [gas and fees](https://docs.arc.io/arc/references/gas-and-fees).

## Next steps

- A memo or reference per batch, to match payouts with invoices or payroll
- EURC payouts and a CSV export of receipts
- Splitting longer lists across several transactions

## License

[MIT](LICENSE)
