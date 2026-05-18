# liquid-snipe

Solana liquidity-event sniper bot. Monitors DEX pool creation and deposit events in real time, evaluates them against configurable strategies, and executes trades via Jupiter + Jito bundles.

Two-gate rollout: **shadow mode** (Gate 1) records decisions and simulated trades without touching the chain; **live mode** (Gate 2) submits real transactions after shadow telemetry meets SLOs.

## Architecture

```
Detection           Validation         Decision      Execution
─────────           ──────────         ────────      ─────────
[Helius WS]    →   [SafetyChecker] →  [Strategy]  → [TxEngine]
[Helius gRPC]      (mint/LP/           (E1..E7,     (Jupiter v6
 (LaserStream)      honeypot sim,       size, exit   + Jito
  merged via         deployer cache)    rules)       bundles)
  DetectionBus)
      │                  │                 │            │
      └──────┬───────────┴─────────────────┴────────────┘
             ▼
  PositionManager (live exit loop)
  ← reserve account updates  → exit decisions  → TxEngine

Cross-cutting: RpcPool, WalletPool, RiskGuard, Metrics, AuditLog, KillSwitch
```

## Quick start

```sh
# Install
bun install

# Configure (fill in secrets, or set HELIUS_API_KEY in env/.env.local)
cp config.example.yaml config.yaml

# Capture whale LP events (POC, offline)
bun run helius:capture -- --duration 600 --min-sol 10

# Snapshot prices for captured pools
bun run snapshot -- --interval 20 --min-sol 10

# Backtest strategies against captured data
bun run backtest

# Shadow mode (Gate 1) — live capture + decision + simulated execution
bun run live:shadow

# Live mode (Gate 2) — real transactions (requires funded hot wallets)
bun run live
```

## Configuration

Single YAML source of truth: `config.yaml` (or `CONFIG_PATH` env). Merges `config.local.yaml` overrides. Supports `${ENV_VAR}` interpolation.

See [`config.example.yaml`](config.example.yaml) for the full schema with comments.

Key sections: `rpc`, `wallet`, `strategies`, `risk`, `jito`, `jupiter`, `killswitch`, `metrics`.

## Strategies

Five built-in strategies (S1–S5), all configurable via YAML:

| ID | Focus | Min SOL | Entry rules |
|---|---|---|---|
| S1-pumpfun-grad | Pump.fun graduations | 5 | MIGRATE event, no mint sanity req |
| S2-meteora-dlmm-size | Large Meteora pools | 25 | INIT/DEPOSIT, E3 mint sanity |
| S3-raydium-fresh-pool | Fresh INIT events | 5 | INIT only, E3 mint sanity |
| S4-tiered-multidex | Multi-DEX, tiered sizing | 1 | Any event, E3, tiered by liquidity |
| S5-fast-trail | Short-window sniping | 0.5 | Any event, E3, tight trail/stops |

Entry signals (E1–E7): first-liquidity, size gate, mint sanity, LP burn, graduation, deployer reputation, quote whitelist. Exit signals (X1–X7): ladder take-profit, trailing stop, time stop, hard stop, liquidity drain, insider sell, momentum decay.

## Safety checks

Every pool event passes through `SafetyChecker` before a decision fires:

1. **Mint authority** — reject if not renounced
2. **LP burn** — require ≥95% at burn/locker addresses
3. **Pool depth** — minimum SOL liquidity per strategy
4. **Honeypot sim** — Jupiter round-trip quote (buy + sell)
5. **Deployer reputation** — blocklist + prior launch count
6. **Program upgradeability** — reject active mint authority

## Risk management

- **Daily P&L cap** — halt trading when loss exceeds configured limit
- **Sim-failure circuit breaker** — 3 consecutive simulation failures halts the bot
- **RPC health gate** — requires at least one healthy provider
- **Per-block capital cap** — limits SOL deployed per block
- **Kill switch** — HMAC-signed HTTP endpoint (`POST /admin/kill`) + file watcher (`data/HALT`)

## Monitoring

Prometheus metrics on `:9090/metrics`:

- `detect_to_decision_ms` — detection to decision latency (histogram)
- `decision_to_broadcast_ms` — decision to broadcast latency (histogram)
- `tx_confirm_rank` — transaction confirmation position (histogram)
- `daily_pnl_sol`, `open_positions`, `revert_rate`, `slot_lag`
- `rpc_p50_ms`, `rpc_p95_ms` — RPC provider health

Grafana dashboard: [`scripts/lib/dashboards/grafana.json`](scripts/lib/dashboards/grafana.json)

## Project structure

```
scripts/
  run-live.ts              # Main entrypoint (--mode shadow|live)
  lib/
    config.ts              # YAML loader + Zod validation
    db.ts                  # SQLite (bun:sqlite), WAL mode, migrations
    logger.ts              # Structured JSON logger
    metrics.ts             # Prometheus exposition (:9090)
    rpc-pool.ts            # Multi-provider RPC with health routing
    laserstream.ts         # Yellowstone gRPC (LaserStream) client
    detection-bus.ts       # Merges WS + gRPC, dedupes by signature
    safety.ts              # 6-check safety validator
    decision.ts            # Strategy evaluator → TradePlan
    signals.ts             # Entry (E1-E7) + exit (X1-X7) signal logic
    tx-engine.ts           # Jupiter swap + Jito bundle submission
    jupiter.ts             # Jupiter v6 quote + swap-instructions
    jito.ts                # Jito bundle builder
    priority-fees.ts       # Dynamic fee estimation
    wallet-pool.ts         # Hot wallet rotation
    price-feed.ts          # Live reserve polling → PriceSnap
    position-manager.ts    # Open position tracking + exit loop
    risk-guard.ts          # Circuit breakers + daily caps
    killswitch.ts          # HMAC kill endpoint + HALT file watcher
    audit.ts               # Structured audit logging + webhook alerts
    types.ts               # Shared type definitions
    dexes.ts               # DEX program registry (8 programs)
    storage.ts             # JSONL append-only persistence
    helius.ts              # Helius SDK client factory
    helius-liquidity.ts    # SOL-flow computation (@solana/kit)
    liquidity.ts           # SOL-flow computation (@solana/web3.js)
  admin/
    halt.ts                # Send signed halt/resume to kill switch
    fund-hot.ts            # Check hot wallet balances
  test/
    signals.test.ts        # Entry/exit signal tests (37 cases)
    risk-guard.test.ts     # Circuit breaker tests (8 cases)
    decision.test.ts       # Decision engine tests (7 cases)
    replay-live.ts         # Backtest parity integration test
  bench/
    snipe-bench.ts         # Latency benchmark (P50/P95)
migrations/
  0001_init.sql            # SQLite schema bootstrap
config.example.yaml        # Full config with comments
```

## Gate 1 → Gate 2 checklist

- [ ] ≥ 24h shadow run, zero crashes
- [ ] P95 detect → decision ≤ 50 ms
- [ ] P95 decision → broadcast ≤ 100 ms (simulated)
- [ ] Sim revert rate < 5%
- [ ] Backtest parity test passes
- [ ] All circuit breakers exercised in integration

## Data

| File | Description |
|---|---|
| `data/pools.jsonl` | Captured pool events (append-only audit log) |
| `data/prices.jsonl` | Price snapshots |
| `data/enrich/*.json` | Mint enrichment (authority, supply, holders) |
| `data/trades.jsonl` | Backtest trade results |
| `data/liquid-snipe.db` | SQLite state (positions, tx attempts, risk) |

## Dependencies

- **Runtime:** `@solana/web3.js`, `@solana/spl-token`, `helius-sdk`, `@jup-ag/api`, `jito-ts`, `@triton-one/yellowstone-grpc`, `yaml`, `zod`
- **Dev:** `bun`, `oxlint`, `oxfmt`

## Proof of concept

See [`docs/proof.md`](docs/proof.md) for the mainnet validation: 21 whale LP events captured, 4 strategies producing positive expectancy, marquee +10.1% trade on Meteora DAMM v2.
