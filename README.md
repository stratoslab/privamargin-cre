# PrivaMargin CRE — Decentralized LTV Monitoring

Chainlink CRE (Compute Runtime Environment) workflow for automated LTV monitoring and liquidation triggers on [PrivaMargin](https://github.com/stratoslab/privamargin) margin positions.

**Live demo**: [portal.stratoslab.xyz](https://portal.stratoslab.xyz/?code=525ZVB8D)

## Why CRE?

PrivaMargin currently monitors LTV in two ways:

| Method | Location | Limitation |
|--------|----------|------------|
| Cloudflare Worker cron | Server-side | Cannot reach Canton JSON API from Workers (404) |
| Browser-side polling | Operator Dashboard | Requires operator to keep dashboard open |

Both approaches are **centralized** — a single operator runs the check. There's no verifiable proof that the prices used were correct or that the LTV computation wasn't manipulated.

**CRE solves this** by running the LTV monitor on a Decentralized Oracle Network (DON):
- N independent nodes fetch prices from CoinGecko and reach **median consensus**
- LTV computations are **deterministic** and **reproducible** across all nodes
- Attestations are written **on-chain** — verifiable proof of price + LTV at each check
- Liquidation triggers are **consensus-backed** — no single party can fake a breach

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Chainlink CRE DON                   │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │  Node 1  │  │  Node 2  │  │  Node N  │           │
│  │          │  │          │  │          │           │
│  │ fetch    │  │ fetch    │  │ fetch    │           │
│  │ prices   │  │ prices   │  │ prices   │           │
│  │ + data   │  │ + data   │  │ + data   │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │              │              │                 │
│       └──────────────┼──────────────┘                 │
│                      │                                │
│              BFT Consensus                            │
│              (median prices,                          │
│               agreed LTV)                             │
│                      │                                │
│              ┌───────▼────────┐                       │
│              │  LTVOracle.sol │                       │
│              │  (Base Sepolia)│                       │
│              │                │                       │
│              │ attestLTV()    │ ← every cycle         │
│              │ triggerLiq()   │ ← on breach           │
│              └───────┬────────┘                       │
└──────────────────────┼───────────────────────────────┘
                       │
                       │ LiquidationTriggered event
                       │
         ┌─────────────▼─────────────┐
         │   PrivaMargin Listener    │
         │   (Cloudflare Worker)     │
         │                           │
         │ 1. MarkMarginCalled       │
         │ 2. SeizeCollateral        │
         │ 3. LiquidatePosition      │
         │ 4. USDC → broker          │
         │                           │
         │   Canton JSON API ←───────│
         └───────────────────────────┘
```

### Data Flow

1. **CRE cron fires** (every 5 min)
2. **Fetch prices** — each DON node independently calls CoinGecko; median consensus produces a single trusted price set
3. **Fetch positions** — DON nodes call `GET /api/cre/positions` on PrivaMargin (server-side Canton query, deterministic)
4. **Fetch vaults + links** — same pattern for collateral values and LTV thresholds
5. **Compute LTV** — pure math: `totalNotional / (effectiveCollateral * leverage)`
6. **Write attestations** — `attestLTV()` on LTVOracle for every position (on-chain proof)
7. **Trigger liquidation** — if LTV ≥ threshold, `triggerLiquidation()` emits event
8. **PrivaMargin listener** watches for `LiquidationTriggered` event, executes Canton operations

### Why Hybrid?

| Concern | CRE handles | PrivaMargin handles |
|---------|-------------|---------------------|
| Price fetching | Consensus-backed (N nodes agree) | — |
| LTV computation | Deterministic, verifiable | — |
| Liquidation trigger | On-chain event (tamper-proof) | — |
| Canton exercises | — | Single execution (no N-fold duplication) |
| USDC settlement | — | Custodian → broker transfer |
| Vault seizure | — | SeizeCollateral choice |

CRE's DON consensus model means every node executes independently. For **reads** (prices, positions), this is ideal — consensus ensures correctness. For **writes** (Canton exercises), N-fold execution would create N duplicate margin calls. The hybrid model keeps writes in a single-execution environment.

## Project Structure

```
privamargin-cre/
├── README.md
├── package.json
├── tsconfig.json
├── contracts/
│   └── LTVOracle.sol              # EVM contract for attestations + triggers
├── src/
│   ├── workflow.ts                # CRE workflow (cron → prices → LTV → trigger)
│   ├── config.ts                  # Types, ABI, constants
│   └── ltv.ts                     # Pure LTV computation (shared with PrivaMargin)
└── privamargin-endpoints/         # Server-side endpoints for PrivaMargin
    ├── cre-positions.ts           # GET /api/cre/positions
    ├── cre-vaults.ts              # GET /api/cre/vaults
    ├── cre-links.ts               # GET /api/cre/links
    └── liquidation-listener.ts    # Event listener for Canton execution
```

## Setup

### Prerequisites

- [Chainlink CRE CLI](https://docs.chain.link/cre/getting-started/overview) installed
- [CRE Early Access](https://chain.link/cre-early-access) approved (for deployment)
- PrivaMargin deployed on Cloudflare Pages with CRE endpoints added
- LTVOracle contract deployed on Base Sepolia (or target chain)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

CRE secrets are threshold-encrypted — no single DON node can see plaintext values.

```bash
# PrivaMargin API secret (authenticates CRE → PrivaMargin requests)
cre secrets set API_SECRET <your-api-secret>
```

### 3. Configure workflow

Edit `src/config.ts` or set via CRE config:

| Config | Description | Example |
|--------|-------------|---------|
| `privamarginApiUrl` | PrivaMargin Pages URL | `https://privamargin.pages.dev` |
| `apiSecret` | Shared secret for /api/cre/* endpoints | `cre-secret-xxx` |
| `chainSelector` | EVM chain selector for LTVOracle | `16015286601757825753` (Base Sepolia) |
| `oracleContractAddress` | LTVOracle deployment address | `0x...` |
| `coingeckoApiUrl` | CoinGecko API base | `https://api.coingecko.com/api/v3` |

### 4. Deploy LTVOracle contract

```bash
# Using Foundry
forge create contracts/LTVOracle.sol:LTVOracle \
  --rpc-url $BASE_SEPOLIA_RPC \
  --private-key $DEPLOYER_KEY \
  --constructor-args $KEYSTONE_FORWARDER_ADDRESS
```

The `forwarder` address is the Chainlink KeystoneForwarder contract on your target chain. See [CRE Supported Networks](https://docs.chain.link/cre/supported-networks-ts).

### 5. Add CRE endpoints to PrivaMargin

Copy the files from `privamargin-endpoints/` to your PrivaMargin deployment:

```
stratos-privamargin/
  functions/api/cre/
    ├── positions.ts    ← from cre-positions.ts
    ├── vaults.ts       ← from cre-vaults.ts
    └── links.ts        ← from cre-links.ts
```

Set the `API_SECRET` environment variable in your PrivaMargin wrangler.toml:

```toml
[vars]
API_SECRET = "cre-secret-xxx"   # Must match CRE workflow config
```

### 6. Simulate locally

```bash
# Build the workflow WASM
cre workflow build

# Run simulation (real API calls, local execution)
cre workflow simulate
```

### 7. Deploy to CRE

```bash
# Requires CRE Early Access approval
# Registers workflow on Ethereum Mainnet (gas fees apply)
cre workflow deploy
```

### 8. Deploy liquidation listener

The listener watches LTVOracle for `LiquidationTriggered` events:

```bash
# In stratos-privamargin repo
cd workflow/
# Add liquidation-listener.ts to your worker
wrangler deploy
```

## LTVOracle Contract

### Functions

| Function | Caller | Purpose |
|----------|--------|---------|
| `attestLTV(positionId, vaultId, ltvBps, collateral, notional, pnl, timestamp)` | CRE DON | Record LTV attestation every cycle |
| `triggerLiquidation(positionId, vaultId, broker, fund, ltvBps, thresholdBps, timestamp)` | CRE DON | Emit liquidation event when breached |
| `getAttestation(positionId)` | Anyone | Read latest attestation |
| `getLiquidationNonce(positionId)` | Anyone | Check liquidation count (replay protection) |

### Events

| Event | Emitted when | Watched by |
|-------|--------------|------------|
| `LTVAttested` | Every monitoring cycle for every position | PrivaMargin UI (verification) |
| `LiquidationTriggered` | LTV ≥ threshold | PrivaMargin liquidation listener |

### Access Control

Only the CRE `KeystoneForwarder` contract can call write functions. This ensures attestations and triggers come exclusively from the DON consensus — no single party can forge them.

## LTV Computation

Same formula as PrivaMargin's existing monitors:

```
effectiveCollateral = vaultValue + sum(PnL of all positions on vault)
LTV = totalNotional / (effectiveCollateral * leverageRatio)
```

- **vaultValue**: Sum of `amount * livePrice` for each collateral asset
- **PnL**: `units * (currentPrice - entryPrice)` for Long, reversed for Short
- **leverageRatio**: From BrokerFundLink (default 1x)
- **threshold**: From BrokerFundLink (default 80%)

The `ltv.ts` module contains pure functions that can be imported by both the CRE workflow and PrivaMargin's browser-side monitor, ensuring identical computation.

## CRE Runtime Constraints

| Constraint | Impact | Mitigation |
|------------|--------|------------|
| QuickJS WASM engine | No `node:crypto`, no Node.js builtins | JWT generation moved to PrivaMargin server (CRE calls authenticated endpoints) |
| Synchronous SDK calls | No async/await with capabilities | Use `.result()` blocking pattern |
| N-fold API calls | Every DON node calls APIs independently | PrivaMargin endpoints are read-only and deterministic; Canton writes in listener only |
| `Date.now()` forbidden | Non-deterministic | Use `runtime.Now()` |
| `Math.random()` forbidden | Non-deterministic | Use `runtime.Rand()` |
| Early Access | Deployment not GA | Build + simulate locally, deploy when approved |

## Comparison: Existing vs CRE Monitor

| Aspect | Browser Monitor | CRE Monitor |
|--------|----------------|-------------|
| Execution | Single operator browser | N-node DON (decentralized) |
| Price source | CoinGecko (single fetch) | CoinGecko (median consensus of N fetches) |
| Verification | SHA-256 hash in KV | On-chain attestation (LTVOracle) |
| Trigger trust | Operator-initiated | DON consensus (tamper-proof) |
| Uptime | Requires open dashboard | Always-on cron |
| Canton writes | Direct (SDK) | Via event listener (single execution) |
| Latency | 30s polling | 5 min cron (configurable) |
| Cost | Free (browser) | CRE fees + EVM gas |

## Status

- [x] CRE workflow code (build + simulate)
- [x] LTVOracle Solidity contract
- [x] LTV computation module (shared with PrivaMargin)
- [x] PrivaMargin server-side endpoints (positions, vaults, links)
- [x] Liquidation event listener
- [ ] CRE Early Access approval
- [ ] LTVOracle deployment on Base Sepolia
- [ ] End-to-end integration test
- [ ] CRE production deployment

## Related

- [PrivaMargin](https://github.com/stratoslab/privamargin) — Main margin trading app
- [Chainlink CRE Docs](https://docs.chain.link/cre)
- [CRE Early Access](https://chain.link/cre-early-access)
- [CRE SDK Reference](https://docs.chain.link/cre/reference/sdk/overview-ts)
