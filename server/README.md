# TestPilot server — real Midscene execution backend

Node + TypeScript backend that drives **Midscene.js** (Puppeteer) against a live site, using your self-hosted OpenAI-compatible vision-language model.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | Liveness + configured model name |
| POST | `/api/model/test` | Probes the VL endpoint: reachable? **accepts images (multimodal)?** Sends a real text call then a real image call. Body: `{ baseUrl, apiKey, modelName }` (optional — falls back to `.env`) |
| POST | `/api/run` | Runs a test case with Midscene. Body: `{ url, steps: string[], expected }` → launches headless Chrome, `agent.aiAction(step)` per step, `agent.aiAssert(expected)`, returns `{ status, durationMs, logs, screenshots[] }` (screenshots are per-step JPEG data URLs) |
| POST | `/api/explore` | Points Midscene at `url` and asks the VL model (`agent.aiQuery`) for the key user flows + P0/P1/P2 priorities. Body: `{ url }` → `{ flows[] }` |
| POST | `/api/generate-code` | LLM-generates runnable Midscene code from steps (template fallback). Body: `{ title, steps, expected }` → `{ code }` |

## Model config

Edit [`.env`](.env). Defaults match the platform's Model config screen:

```
OPENAI_BASE_URL=http://127.0.0.1:8000/v1
OPENAI_API_KEY=1234
MIDSCENE_MODEL_NAME=Qwen3.6-35B-A3B-4bit
MIDSCENE_USE_QWEN3_VL=1        # Qwen2.5-VL → use MIDSCENE_USE_QWEN_VL=1 instead
```

The `/api/model/test` probe is the ground-truth check for the project's #1 risk: **is `Qwen3.6-35B-A3B-4bit` actually multimodal?** If the image call fails, it reports `notMultimodal` and Midscene's visual grounding won't work.

## Run

```bash
pnpm install          # installs Midscene + Puppeteer (downloads Chromium)
pnpm dev              # http://localhost:5301  (tsx watch)
```

Requirements to actually execute runs:
1. Your VL model serving at `OPENAI_BASE_URL` (e.g. the local Qwen at `:8000`).
2. A Chromium/Chrome for Puppeteer — bundled on install, or set `PUPPETEER_EXECUTABLE_PATH` to an installed Chrome.

If pnpm skipped Puppeteer's browser download (build-scripts prompt), run:
```bash
pnpm approve-builds        # approve puppeteer
# or: node node_modules/puppeteer/install.mjs
```

## Platform API: persistence · planning · export · cache

Data lives in SQLite (`.data/testpilot.db`, seeded on first run) — see [src/db.ts](src/db.ts).

| Method / path | What it does |
|---|---|
| `GET/POST /api/projects` | list / create projects |
| `GET/POST /api/cases`, `PATCH/DELETE /api/cases/:id` | CRUD test cases (persisted) |
| `POST /api/projects/:id/explore` | **AI-plan** P0/P1/P2 flows and save them as cases. `{ deep: true }` does an **agentic crawl** — logs in / advances a screen and re-plans, so post-login flows are grounded in the real UI (saucedemo deep crawl → 17 cases with real product names & checkout fields, vs 8 inferred single-page) |
| `POST /api/cases/:id/generate-code` | LLM-generate Midscene code for a case, persisted |
| `POST /api/cases/:id/run` | execute the case with Midscene, persist a run + update status. Pass `{ "provider":"injected" }` for dapp runs. Caches per case (`cacheId`) so **re-runs replay from cache** (MIDSCENE_CACHE=1 → ~3× faster: 14.8s → 4.8s measured) |
| `GET /api/runs` | run history |
| `GET /api/projects/:id/export` | download a **standalone runnable Playwright + Midscene project** (zip; `?format=json` for the file map) — `pnpm install && npx playwright install && pnpm test`. See [src/export.ts](src/export.ts). |

The frontend Test-cases board loads/saves through these (source of truth = DB), with an
**Export tests** button. Set `MIDSCENE_CACHE=1` (in [.env](.env)) to enable the run cache.

## Wallet extension (for dapp / testnet testing)

The browser is **Chrome for Testing** (Puppeteer v23's default build — the automation-optimized, version-pinned Chrome), launched in **new headless mode** (`headless: true`). Only this mode supports extensions — the stripped `chrome-headless-shell` and old headless do not.

One-time setup:

```bash
pnpm setup:wallet      # downloads latest MetaMask, unpacks to .wallets/metamask
pnpm gen:wallet        # generates a FRESH private wallet → .wallets/seed.txt (mode 600) + account.txt
pnpm setup:onboard     # imports that seed into a persistent profile (.wallets/profile)
```

`gen:wallet` creates a **fresh, private, controllable** mnemonic (via `ethers`) — the seed
never leaves `.wallets/seed.txt` (chmod 600) and is never printed; only the public address
is echoed. `setup:onboard` then drives MetaMask's onboarding headlessly (import wallet →
seed → password → skip passkey → accept metrics), preferring `.wallets/seed.txt` over the
public Hardhat fallback. Override with `TEST_SEED` / `TEST_WALLET_PASSWORD`.

> **Never use a public mnemonic with real funds.** `gen:wallet` exists so the wallet is one
> we control, not the world-readable Hardhat account. Even so, this profile is for local /
> test chains only — never fund it on mainnet.

### Controllable local chain (Anvil) + a real transaction

Run a local devnet that funds *our* account (chainId **31337**, not a public testnet):

```bash
pnpm chain             # anvil --mnemonic <our seed> --chain-id 31337 --port 8545
                       # → our account is pre-funded with 10000 ETH on a chain we control
pnpm test:localtx      # connect → add Anvil network → send 0.01 ETH → verify on-chain
```

`test:localtx` ([scripts/test-localtx.mjs](scripts/test-localtx.mjs)) drives the test dapp:
connect → `wallet_addEthereumChain` (Anvil Local) → `eth_sendTransaction` (0.01 ETH). The
approver auto-confirms the add-network and **transaction** popups, then it asserts the tx
mined via `eth_getTransactionReceipt` (`status: 0x1`) and the recipient balance rose by
exactly `0.01 ETH`. Verified end-to-end — a real signed transaction, on a chain we own.

### Our controllable wallet on public Sepolia

```bash
pnpm test:sepolia      # connect → switch to real Sepolia → report balance → tx if funded
```

`test:sepolia` ([scripts/test-sepolia.mjs](scripts/test-sepolia.mjs)) connects our
controllable wallet, switches to **real Sepolia** (`chainId 0xaa36a7`, switch popup
auto-approved), and reads the balance. A freshly generated account has **0 Sepolia ETH**, so
it stops at `funded: false`. Fund our address (in `.wallets/account.txt`) from a faucet —
e.g. the no-login PoW faucet <https://sepolia-faucet.pk910.de>, or Google Cloud / Alchemy /
Chainlink faucets — then re-run: it sends `0.001 ETH` and verifies the receipt on a public
Sepolia RPC. Unlike the public Hardhat account, this address is **ours**, so it is safe to
fund on a public testnet.

### Real Uniswap-infra transaction on Sepolia (WETH wrap)

> **app.uniswap.org does not support Sepolia** — testnets aren't in its network picker and
> `?chain=sepolia` redirects to mainnet. Known, unfixed limitation on Uniswap's side (see
> [interface discussion #7641](https://github.com/Uniswap/interface/discussions/7641)), not
> an automation gap. To swap via the real UI you'd self-host the interface for testnet or use
> a mainnet fork.

`test:wrap` drives a real, reliable Uniswap-infrastructure tx on Sepolia instead:

```bash
pnpm test:wrap         # connect → switch Sepolia → wrap 0.001 ETH → WETH → verify on-chain
```

`test:wrap` ([scripts/test-wrap.mjs](scripts/test-wrap.mjs)) calls the canonical Sepolia WETH
`deposit()` (ETH↔WETH is Uniswap's "wrap" — no pool/liquidity needed). The approver confirms
the MetaMask tx popup, then it verifies via a public Sepolia RPC that the tx **mined**
(`status: 0x1`) and WETH balance rose by exactly `0.001`. Verified public on-chain tx from
our controllable wallet — e.g. `0xbce675f7…54f50` in Sepolia block `11193590`.

## Mainnet fork — real Uniswap swap (the recommended dapp-testing capability)

The general capability for automated dapp testing is an **injected virtual wallet provider +
Anvil mainnet fork** (the mainstream pattern — cf. [@wonderland/walletless](https://github.com/defi-wonderland/walletless),
[headless-web3-provider](https://github.com/cawabunga/headless-web3-provider), [Synpress](https://synpress.io/)).
Fork mainnet so real protocol contracts + liquidity exist; fund any account instantly.

```bash
echo "https://eth-mainnet.g.alchemy.com/v2/<KEY>" > .wallets/mainnet-rpc.txt
pnpm fork               # anvil --fork-url <key> --chain-id 1 --mnemonic <our seed> (funds us)
pnpm test:fork-router   # real Uniswap v3 swap ETH→USDC on the fork, verified on-chain
pnpm test:fork-swap     # inject an EIP-6963 provider (no MetaMask) + drive app.uniswap.org
```

- [test-fork-router-swap.mjs](scripts/test-fork-router-swap.mjs) calls Uniswap `SwapRouter02`
  `exactInputSingle` (WETH/USDC 0.05% pool) from our wallet on the fork. **Verified: 0.01 ETH
  → 17.26 USDC, tx `0xaba53faa…3d86`, status `0x1`, block 25451032.** Real swap, real
  liquidity, zero cost.
- [test-fork-swap.mjs](scripts/test-fork-swap.mjs) injects an EIP-1193/EIP-6963 provider
  (reports chainId 1, proxies signing/RPC to the fork) so a real dapp UI connects **headless,
  no MetaMask**. It also redirects the page's JSON-RPC POSTs to the fork.

> **Uniswap's production UI can't see a local fork.** Its balances/quotes come from Uniswap's
> proprietary indexed backend (`entry-gateway…api.uniswap.org` GraphQL), not any RPC — so
> even with fork-funded ETH the UI shows "add funds". This is a Uniswap-specific coupling; the
> documented fix is to **self-host the Uniswap interface** pointed at the fork. For the
> majority of dapps (which read chain state via the connected provider / a public RPC), the
> injected-provider + fork approach drives the real UI headlessly and executes real txs. For
> Uniswap specifically, drive it via **direct router calls on the fork** (as above).

### General capability: injected wallet, configurable RPC

The injected virtual wallet is a first-class TestPilot capability ([src/injectedWallet.ts](src/injectedWallet.ts)),
with the **chain RPC fully configurable** — point it at a local Anvil fork, a Tenderly Virtual
TestNet public RPC, or a public testnet.

Config (env in [.env](.env), overridable per request):

```
CHAIN_RPC_URL=http://127.0.0.1:8545   # what the injected provider proxies to
CHAIN_ID=1
```

APIs:
- `GET /api/config` → `{ chain: { rpcUrl, chainId }, account }`
- `POST /api/run` with `{ "provider": "injected", "rpcUrl"?, "chainId"? }` → runs Midscene
  steps against a dapp with the injected wallet (no MetaMask popups; wallet ops auto-resolve).
- `POST /api/dapp/verify` `{ "url"?, "rpcUrl"?, "chainId"? }` → **model-free proof**: opens a
  dapp with the injected wallet, connects, sends a real tx, verifies the receipt. Example:
  `{ connect: "connected:0x6765…", tx: "0x1c3c4b…", mined: true, txStatus: "0x1" }`.

`launchSession(url, { injected: true, rpcUrl?, chainId? })` sets it up: no extension, headless,
`window.ethereum` reports the chainId and proxies signing/reads to the RPC; the page's own
JSON-RPC POSTs are redirected there too. This is the recommended default for automated dapp
testing; the real-MetaMask path stays available for tests that must exercise wallet-popup UX.

Then `launchSession(url, { wallet: true })`:
1. loads MetaMask via `--load-extension` using the **onboarded** `.wallets/profile`,
2. resolves the extension id from its MV3 service-worker target,
3. **auto-unlocks** the wallet and keeps that page open.

> **MV3 gotcha:** MetaMask's decrypted vault lives only in the service worker's memory.
> If every extension page closes, the SW is killed and the wallet re-locks. So the unlock
> page is deliberately kept open for the session's lifetime ([src/wallet.ts](src/wallet.ts)).

Verify the wallet boots ready + unlocked:

```bash
curl -X POST http://localhost:5301/api/wallet/check -d '{}' -H 'Content-Type: application/json'
# → { "loaded": true, "unlocked": true, "account": "0xf39F…2266",
#     "walletId": "pbdgaohnjnklhapgkhobadckfpbjamgg", "screenshot": "data:image/jpeg;..." }
```

Selectors were discovered live for MetaMask v13.37.0 with [scripts/inspect-onboarding.mjs](scripts/inspect-onboarding.mjs);
expect to re-run it if MetaMask changes its onboarding.

### Connecting a dapp + signing (auto-approve popups)

`startPopupApprover(browser)` ([src/wallet.ts](src/wallet.ts)) runs a background loop that
approves MetaMask's connect / signature / tx popups (unlock-in-popup if locked, dismiss
passkey, click confirm — by testid `confirm-btn` with a text fallback). Start it, drive the
dapp, stop it. Full smoke test against the built-in [/testdapp](src/index.ts):

```bash
curl -X POST http://localhost:5301/api/wallet/dapp-test -d '{}' -H 'Content-Type: application/json'
# → { "connect": "connected:0xf39f…92266", "sign": "signed:0x96c5…", "account": "0xf39F…2266" }
```

> **Headed required for the wallet.** MetaMask's onboarding-completion and connect popups
> stay half-initialized in headless (the "Open wallet" button never enables; connect popups
> hit `#/lock` and auto-reject). So `launchSession({ wallet: true })` defaults to **headed**
> (a real Chrome window). On a Linux CI box, wrap it in `xvfb-run`. Force headless with
> `HEADLESS=1` (not recommended for wallet flows). Non-wallet runs stay headless.

### Verified against production Uniswap

`pnpm test:uniswap` ([scripts/test-uniswap.mjs](scripts/test-uniswap.mjs)) drives the **real**
`app.uniswap.org` end to end (deterministic, no model):

1. unlock → click `navbar-connect-wallet` → pick MetaMask (option rows have no testids, so it
   clicks the smallest element mentioning "MetaMask") → approver auto-confirms the popup →
   Uniswap header shows the account → `connected: account-visible`.
2. **switch to Sepolia** via `wallet_switchEthereumChain` (adds it on 4902); the approver
   confirms the network-switch popup → `eth_chainId: 0xaa36a7` (11155111).
3. **drive a swap**: pick an output token (`token-option-*`), type `0.001` into
   `amount-input-in` → Uniswap returns a live quote → the swap button reads its real state.

With an unfunded account this ends at **"Insufficient ETH"** (`swapState: "ETH 不足"`) — the
exact gate before "Review → Confirm swap → MetaMask tx popup". Fund the account from a
Sepolia faucet and the same run reaches the tx-confirm popup (which the approver confirms).
Set `NO_SWAP=1` to stop after connect.

`/api/run` accepts `{ "wallet": true }`: it launches the headed wallet and runs
`startPopupApprover` for the duration, so any Midscene `aiAction` that triggers a wallet
popup (connect / sign / tx) is auto-approved. Driving the dapp's own buttons is where
Midscene's `aiAction` (your VL model) comes in.

### How to control the extension

Extension UI pages are just `chrome-extension://<id>/<page>` — `openWalletPage(browser, walletId, path)` opens them. Because Midscene is **vision-driven**, you drive the wallet by natural language instead of brittle selectors:

```ts
const wallet = await openWalletPage(browser, walletId, "home.html#onboarding/welcome");
const wAgent = new PuppeteerAgent(wallet);
await wAgent.aiAction('click "Import an existing wallet"');
await wAgent.aiAction("enter the test seed phrase and click Confirm");
// dapp connect / tx confirm popups open as chrome-extension://<id>/notification.html
```

For heavier MetaMask flows you can alternatively use [Dappwright](https://github.com/TenKeyLabs/dappwright) or [Synpress](https://synpress.io/) (Playwright-based). Use a throwaway **test seed phrase** only — never a real one.

## How the frontend uses it

The web app ([../src/lib/api.ts](../src/lib/api.ts)) calls these endpoints. Every store action **falls back to the built-in simulation when this server is offline**, so the UI works standalone — start the server to switch to real execution with no frontend change.
