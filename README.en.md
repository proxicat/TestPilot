<p align="center">
  <img src="docs/screenshots/en/01-projects.png" alt="TestPilot" width="820">
</p>

<h1 align="center">TestPilot</h1>

<p align="center">
  <b>AI-driven end-to-end testing for web apps and Web3 dapps.</b><br>
  Point it at a URL — the AI explores the flows, drives the real UI, and returns a deterministic verdict.
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/简体中文-64748B?style=for-the-badge" alt="简体中文"></a>
  <a href="README.en.md"><img src="https://img.shields.io/badge/English-2563EB?style=for-the-badge" alt="English"></a>
  <a href="README.ja.md"><img src="https://img.shields.io/badge/日本語-64748B?style=for-the-badge" alt="日本語"></a>
</p>

<p align="center">
  <img alt="stack" src="https://img.shields.io/badge/frontend-React_18_+_Rsbuild-149ECA">
  <img alt="server" src="https://img.shields.io/badge/backend-Express_+_SQLite-3C873A">
  <img alt="engine" src="https://img.shields.io/badge/engine-Midscene_+_Puppeteer-8B5CF6">
  <img alt="model" src="https://img.shields.io/badge/model-Qwen--VL_self--hosted-FF6A00">
</p>

---

## Table of contents

- [What is TestPilot](#what-is-testpilot)
- [Core capabilities](#core-capabilities)
- [Feature tour (with screenshots)](#feature-tour-with-screenshots)
- [Architecture](#architecture)
- [Run pipeline](#run-pipeline)
- [Dapp / Web3 testing](#dapp--web3-testing)
- [AI model dependency](#ai-model-dependency)
- [Local development](#local-development)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)

---

## What is TestPilot

TestPilot hands "a whole QA department's automation work" to an AI:

1. **Explore** — give it a URL; a vision-language model reads the page and proposes test cases with **P0/P1/P2 priority** and a business rationale.
2. **Execute** — [Midscene](https://midscenejs.com/) drives a **real browser** with natural-language steps against the real UI (no selectors).
3. **Judge** — every run uses a **dual oracle**: a functional assertion (vision) plus deterministic checks (on-chain / performance / visual baseline).
4. **Govern** — suite runs, CI gates, self-healing retries, flakiness stats, a trends dashboard, and runnable-code export.

Unlike record-and-replay or hand-written selectors, cases are expressed in natural language, so a small UI change doesn't break them en masse; verdicts lean on deterministic signals (tx receipts, pixel baselines, performance budgets), decoupling the flaky visual judgement from the reliable result judgement.

> **Web3 dapp E2E is a first-class focus.** The user interacts with the dapp's UI; the ground truth of that interaction is "the wallet gained a confirmed transaction." TestPilot auto-approves the wallet popup with an injected virtual wallet and turns that tx receipt into a first-class assertion — never bypassing the UI.

---

## Core capabilities

| Capability | What it does |
|---|---|
| 🧭 **AI explore** | Vision model reads the site → generates prioritized cases with rationale; supports deep crawl and "Dapp mode" |
| ⌨️ **Natural-language cases** | Steps are plain English ("Click Send 0.01 ETH"), no CSS selectors |
| ✅ **Dual oracle** | Functional assertion (`aiAssert`) + on-chain assertions / visual-baseline diff / performance budget |
| ⛓ **Dapp / on-chain assertions** | Injected wallet auto-confirms popups; assert balance deltas and **"wallet sent a successful tx" (receipt status=1)** |
| 🔁 **Suite · gate · self-heal** | Concurrency queue, retry on failure, cache-bust self-heal, CI gate, flakiness stats & quarantine |
| 📊 **Trends dashboard** | Pass rate, flake rate, mean-time-to-repair, coverage, heal rate |
| 🔐 **Environments & secrets** | Per-project env vars, encrypted secrets, login state (API login / cookie / storageState) |
| 🧬 **Data-driven** | Bind a dataset, run once per row (`${row}` / `${row.col}`) |
| 📤 **Code export** | One-click export to a runnable Playwright project (env / secrets / login state / CI) |
| 🌐 **Trilingual + dark** | zh / en / ja; the active language is sent to the model to constrain its output language |

---

## Feature tour (with screenshots)

### Project portfolio
Point TestPilot at multiple sites, each with its own E2E suite. Two-level nav: portfolio (Level 0) ↔ in-project (Level 1).

![Portfolio](docs/screenshots/en/01-projects.png)

### AI explore
Enter a URL → the model reads live screenshots of the page → produces "discovered flows" with priority and business rationale. Deep crawl and Dapp mode supported.

![Explore](docs/screenshots/en/06-explore.png)

### Test-case board
A P0/P1/P2 board. Each case carries natural-language steps, an expected assertion, data-driven binding, a Web3 run mode, on-chain assertions, generated code, a quarantine toggle, and the last run result inline.

![Cases](docs/screenshots/en/02-cases-board.png)

### ⛓ Dapp / on-chain assertions (the headline)
A case can run with an **injected virtual wallet** and carry **on-chain assertions**. Below: one real UI click on "Send 0.01 ETH" → assert "wallet sent a successful tx ≥ 1" → poll the receipt to confirm it mined → pass. That is the closest thing to the user's truth, and it doesn't depend on the model reading the dapp's success UI.

![Dapp on-chain assertion](docs/screenshots/en/03-dapp-case-onchain.png)

### Suite & CI gate
Run by priority in bulk; each suite yields pass/fail, a gate result (can block CI), and retry/heal records.

![Suite](docs/screenshots/en/05-suite.png)

### Run report
A project-level run ledger: total runs, pass rate, P0 pass rate, average duration, and per-run oracle details.

![Runs](docs/screenshots/en/04-runs-report.png)

### Trends dashboard
Pass rate over time (green = gate passed, red = gate failed), flake rate, mean-time-to-repair, coverage, heal rate, and per-suite result distribution.

![Trends](docs/screenshots/en/09-trends.png)

### Chain / Dapp config
Test chain, RPC, and wallet in their own panel: presets for a local Anvil fork / Tenderly Virtual TestNet / public testnet, a controlled test wallet, one-click real verification of the injected wallet, plus a "how to test a dapp" guide and a Uniswap example.

![Chain config](docs/screenshots/en/07-chain-config.png)

### Model config
Connect a self-hosted, OpenAI-compatible vision-language endpoint: base URL, API key, model name, model family, with an endpoint preview and copyable environment variables.

![Model config](docs/screenshots/en/08-model-config.png)

---

## Architecture

TestPilot = frontend (Rsbuild/React) + backend (Express/SQLite) + run engine (Midscene drives the browser + injected wallet + on-chain assertions) + a self-hosted vision-language model + a test chain.

```mermaid
flowchart LR
  subgraph UIapp["Browser UI  :5300"]
    FE["React + Rsbuild<br/>projects / cases / suite / trends / chain config"]
  end

  subgraph Backend["Backend  :5301  (Express + tsx)"]
    API["REST + SSE API"]
    DB[("SQLite<br/>better-sqlite3")]
    ENGINE["Run engine<br/>queue · self-heal · oracle"]
    MID["Midscene<br/>PuppeteerAgent"]
    WAL["Injected virtual wallet<br/>EIP-1193/6963 · ethers"]
    CH["On-chain assertions<br/>eth_call / receipt"]
  end

  subgraph Model["Vision-language model (self-hosted)"]
    PROXY["no-think proxy  :8010"]
    VLM["Qwen-VL family  :8000"]
  end

  BR["Headless Chrome"]
  CHAIN["Test chain<br/>Anvil fork / testnet  :8545"]

  FE -->|"fetch / EventSource"| API
  API --> DB
  API --> ENGINE
  ENGINE --> MID
  MID -->|"plan + visual grounding"| PROXY --> VLM
  MID -->|"drive real UI"| BR
  ENGINE --> WAL -->|"sign / send tx"| CHAIN
  ENGINE --> CH -->|"read balance / poll receipt"| CHAIN
  BR -.->|"dapp RPC reads redirected"| CHAIN
```

**Key point:** Midscene does **UI automation only** (not extended, not modified); TestPilot wraps an "injected wallet + on-chain assertion" layer around it. In injected mode we **are** the wallet — we record the tx hash at the source it's sent, with no chain polling or wallet listening.

---

## Run pipeline

How a run flows, and how failures are classified/healed:

```mermaid
flowchart TD
  A["Launch session<br/>injected wallet / login state / headers / query"] --> B["Navigate to target URL"]
  B --> C["On-chain snapshot (before)"]
  C --> D["Execute aiAction step by step<br/>vision model drives the real UI"]
  D --> E["Functional oracle: aiAssert (vision)"]
  E --> F["On-chain oracle<br/>balance delta · txSubmitted receipt · visual baseline · perf budget"]
  F --> G{"All pass?"}
  G -->|"yes"| H["✅ passed"]
  G -->|"no"| I["❌ failed"]
  D -.->|"model / network error"| J["⚠ infra error (not a test failure)<br/>auto-retry + cache-bust self-heal"]
  J -.-> D
```

The functional assertion (vision model) is the flaky part; the on-chain / pixel / performance checks are deterministic ground truth. Both gate the verdict, decoupling "UI-driving reliability" from "result judgement."

---

## Dapp / Web3 testing

**Principle: never bypass the UI.** The user interacts with the dapp's interface; that action ultimately shows up as one more transaction in their wallet. TestPilot follows the modern mainstream approach (Synpress-mock / Dappwright) — inject an EIP-1193/6963 provider that auto-confirms the connect / sign / transaction popups, while the dapp's own UI is genuinely clicked throughout.

```mermaid
sequenceDiagram
  autonumber
  participant M as Midscene (vision model)
  participant UI as dapp UI
  participant W as Injected wallet (provider)
  participant C as Test chain
  M->>UI: Click "Send / Swap" (real UI action)
  UI->>W: eth_sendTransaction
  W->>C: wallet.sendTransaction() signs & broadcasts
  C-->>W: tx hash
  W-->>UI: returns hash (auto-confirmed, no popup)
  Note over W: record the tx hash for this run
  M->>C: at run end, poll each receipt
  C-->>M: status = 1 (mined, successful)
  Note over M: assert "wallet sent a successful tx" ✓
```

**On-chain assertion types:** `balance increased / decreased / changed`, `balance ≥ / ≤ / = threshold` (ERC-20 or native), `wallet sent ≥N successful txs (txSubmitted)`. These are **deterministic RPC calls — no LLM involved** — hence the most reliable verdict; the vision assertion only backstops the UI layer.

**Testing your own dapp:** TestPilot does not deploy dapps. You provide a dapp URL + one chain RPC (local fork / Tenderly / testnet); the platform injects a controlled wallet that connects to it. The repo ships `/testdapp` (connect / sign / send tx / WETH wrap) for out-of-the-box verification, and the chain-config page includes a Uniswap example and guidance.

> ⚠️ **About production Uniswap:** its frontend reads balances from its own backend gateway (invisible to a fork) and its UI is very dense — hard to drive reliably with a **self-hosted 35B model**. This is a **model-capability axis** issue, not a platform-design one: point `MIDSCENE_MODEL_*` at a stronger vision model and it works; the on-chain assertion layer is model-independent. The built-in `/testdapp` cases (connect / sign / send tx + on-chain assertions) run green reliably even on the local model.

---

## AI model dependency

TestPilot relies on an **OpenAI-compatible vision-language (VL) endpoint** for page planning and visual grounding. The default, verified setup:

| Item | Value |
|---|---|
| Model | **Qwen3.6-35B-A3B-4bit** (Qwen3-VL family, self-hosted, e.g. MLX / vLLM) |
| Endpoint | `http://127.0.0.1:8010/v1` (no-think proxy; the raw model is on `:8000`) |
| Model-family flag | `MIDSCENE_USE_QWEN3_VL=1` (use `MIDSCENE_USE_QWEN_VL=1` for Qwen2.5-VL) |
| Cache | `MIDSCENE_CACHE=1` (cache planning per case so regression re-runs replay without the model) |

Configure it visually on the "Model config" page, or via environment variables (`server/.env`):

```bash
MIDSCENE_MODEL_BASE_URL=http://127.0.0.1:8010/v1
MIDSCENE_MODEL_API_KEY=your-key
MIDSCENE_MODEL_NAME=Qwen3.6-35B-A3B-4bit
MIDSCENE_USE_QWEN3_VL=1
```

**Swap in any VL model:** as long as the endpoint is OpenAI-compatible and the model supports visual grounding (Qwen-VL, or a stronger frontier model), point the three values above at it. The stronger the model, the better it drives dense UIs like Uniswap.

> 🧠 **Memory note:** running a large VL model on a VRAM/RAM-constrained machine, a bigger page DOM means a bigger prompt, which is more likely to trip the memory guard. TestPilot already downsamples the screenshot viewport (`MIDSCENE_SHOT_WIDTH/HEIGHT`, default 1024×720) to keep the prompt small; if that's still not enough, use a machine with more VRAM or a smaller model.

---

## Local development

### Prerequisites

- **Node.js ≥ 20** (verified on 22) and **pnpm**
- An **OpenAI-compatible vision-language endpoint** (see above)
- (optional, for dapp testing) **Foundry / anvil** to run a local chain or fork

### 1) Install

```bash
# Frontend (repo root)
pnpm install

# Backend
cd server && pnpm install && cd ..
```

### 2) Configure the model (backend)

```bash
# Edit server/.env with your MIDSCENE_MODEL_* endpoint (see "AI model dependency")
```

### 3) Start the services

```bash
# Terminal A — backend API (:5301)
cd server && pnpm dev

# Terminal B — frontend (:5300)
pnpm dev
```

Open **http://localhost:5300** .

### 4) (Optional) Dapp testing: start a test chain

```bash
cd server
pnpm gen:wallet          # generate a controlled test wallet (.wallets/seed.txt)
pnpm chain               # local Anvil (chainId 31337)
# or fork mainnet:
pnpm fork                # anvil --fork-url ... (chainId 1)
```

On the "Chain / Dapp config" page, point the RPC at `http://127.0.0.1:8545` and run dapp cases with the injected wallet.

### Ports

| Port | Service |
|---|---|
| `5300` | Frontend (Rsbuild dev) |
| `5301` | Backend API + built-in `/testdapp` |
| `8010` | Model no-think proxy |
| `8000` | Raw VL model |
| `8545` | Test chain (Anvil / fork) |

### Common scripts

```bash
pnpm typecheck                 # frontend type-check
cd server && pnpm typecheck    # backend type-check
pnpm build                     # frontend production build → dist/
```

---

## Tech stack

| Layer | Choice |
|---|---|
| Build / bundling | **Rsbuild** (Rspack, Rust core) + **SWC** transpile |
| Frontend | React 18 · TypeScript · react-router v6 (hash router) · Zustand · Tailwind v3 · lucide-react |
| Backend | Express · tsx · **better-sqlite3** (embedded SQLite) · cors · dotenv |
| Automation engine | **@midscene/web** (PuppeteerAgent) · Puppeteer (headless Chrome) |
| Web3 | **ethers v6** (injected wallet signing/sending) · EIP-1193 / EIP-6963 provider |
| Visual diff / perf | pixelmatch · pngjs · Puppeteer performance metrics |
| Model | Self-hosted Qwen-VL (OpenAI-compatible) · no-think proxy |
| i18n | zh / en / ja dictionaries + language constraint sent to the model |

---

## Project layout

```
testpilot/
├── src/                    # Frontend (React + Rsbuild)
│   ├── pages/              # Projects / Explore / CasesBoard / Suite / Trends / RunReport / ModelConfig / ChainConfig
│   ├── components/         # Layout / Sidebar / primitives
│   └── lib/                # store (zustand) · api · types · i18n · prefs
├── server/                 # Backend (Express + tsx)
│   └── src/
│       ├── index.ts        # API + run engine (executeRun / suite / explore SSE)
│       ├── agent.ts        # launchSession: Midscene + injected wallet + login state/headers/query
│       ├── injectedWallet.ts  # EIP-1193/6963 injected virtual wallet
│       ├── chain.ts        # on-chain assertions (balance / txSubmitted receipt)
│       ├── db.ts           # SQLite schema & migrations
│       ├── config.ts       # model / chain / viewport resolution
│       └── settings.ts     # exploration-methodology prompt / language constraint
├── docs/screenshots/       # screenshots used by this README (zh / en / ja)
└── README.md               # Chinese (default) · README.en.md · README.ja.md
```

---

## Roadmap

- **P1** — real MetaMask popup mode wired into the run pipeline (for teams that must test the real popup UX)
- **P2** — more on-chain assertions: nonce/txCount, event logs, ERC-20 allowance, ERC-721 owner
- Stronger vision-model integration and Midscene plan caching to drive complex, production-grade dapp UIs

---

<p align="center">
  <sub>Powered by Midscene · built to hand a department's automation testing to an AI.</sub>
</p>
