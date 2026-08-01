# $PC Commitment Rewards — community frontend

Open-source, community-built frontend for the Pentagon Chain **$PC Commitment
Rewards** program: members lock $PC (ERC-20) on Ethereum for 3–24 months and
receive **$PC loyalty rewards on Pentagon Chain** — closed-loop, in-ecosystem
points (no cash value, no withdrawal path), claimable weekly, from a finite
pre-funded pool. No new $PC is minted. Not a deposit, security, or investment.

> **Status: preview.** The program contracts are not deployed yet (pending
> review and audit); `public/config.js` carries zero addresses and the page
> runs in read-only preview mode until launch.

## Why this repo is public

Program frontends should outlive their operators. Anyone in the community can
review, fork, and **self-host** this interface — if the official deployment
ever goes away, the program remains usable directly through the on-chain
contracts, and this UI can be revived by anyone. (Non-custodial, "as is": you
transact with the contracts from your own wallet; this page holds nothing.)

## Self-hosting

The site is fully static (`public/`) plus one optional Cloudflare Pages
Function (`functions/stake/rpc.js`).

**Cloudflare Pages (recommended):** fork → Pages → Connect to Git → build
command empty, output dir `public` (auto-detected from `wrangler.toml`). Set
the `LEDGER_ADDRESS` env var on the project to enable the `/stake/rpc`
read-proxy (the public Pentagon RPC sends no CORS headers, so browsers can't
read the rewards ledger directly — the tiny proxy fixes that; it is locked to
`eth_call` on the ledger address only).

**Any other static host:** serve `public/` as-is. Everything works except the
in-page "points accrued" display (which needs the proxy or a CORS-enabled RPC —
set your own in `config.js`). Committing, withdrawing, and claiming are wallet
transactions and work regardless.

## Configuration (`public/config.js`)

| Key | What |
|---|---|
| `stakeVaultAddress` | PCStakeVault proxy (Ethereum) |
| `ledgerAddress` | PCStakeLedger proxy (Pentagon Chain) |
| `pcChainIdHex` | Pentagon Chain chain-id (for wallet add/switch) |
| `ledgerRpcProxy` | path or URL of the read-proxy (default `/stake/rpc`) |

No secrets belong in this repo — configuration is public addresses only.

## Security notes for self-hosters

- Pin the ethers CDN `integrity` hash (already done in `index.html`).
- The read-proxy must stay `eth_call`-only and address-locked (as shipped).
- Verify contract addresses against official Pentagon Games announcements
  before pointing users at your fork.
