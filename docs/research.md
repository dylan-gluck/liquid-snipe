# Liquidity-Sniping Research (v2)

Anchor doc for the v2 POC. Establishes the taxonomy the scripts under
`scripts/` implement and backtest. Cross-reference: every signal id below
(E1, X3, S2, B4, …) maps to a named export or CLI subcommand in
`scripts/signals.ts`, `scripts/backtest.ts`.

## 1. What the monitor actually captures

`scripts/monitor-liquidity.ts` subscribes to program logs on 8 program ids
(Raydium AMM v4/CPMM/CLMM, Orca Whirlpool, Meteora DLMM/DAMM v2, Pump.fun,
PumpSwap) and tags each tx as `INIT`, `DEPOSIT`, `CREATE`, or `MIGRATE`. From
the user's session logs across ~50 minutes of public-mainnet sampling at
`--min-sol 1`:

| program         | seen  | reported≥1 SOL | notes                                   |
| --------------- | ----- | -------------- | --------------------------------------- |
| raydium-amm     | ~9000 | 1–2            | majority dropped (concurrency=4)        |
| pumpfun         | ~2700 | 0              | log volume highest, signal density low  |
| meteora-dlmm    | ~1000 | 0–1            | one 50 SOL DEPOSIT — largest single hit |
| meteora-damm-v2 | ~130  | 0–1            | one 11 SOL INIT                         |
| pumpswap        | ~170  | 0              | bursts after pump.fun graduations       |
| raydium-cpmm    | ~640  | 0              | low traffic                             |
| raydium-clmm    | ~50   | 0              | low traffic                             |
| orca-whirlpool  | ~10   | 0              | basically silent                        |

Observations that drive the strategy design:

- **Public mainnet-beta is unusable for production.** Drop ratio >85% on
  Raydium AMM at 4-inflight. A paid RPC (Helius / QuickNode / Triton) with
  `--max-inflight` 32–64 is table stakes.
- **The named tokens include `…pump` mint suffixes** (e.g. `DKu9…pump`,
  `AzC1…pump`). These are pump.fun graduates that already migrated to
  Raydium — the AMM v4 DEPOSIT we caught is the post-migration LP add.
- **Single-event signal is not enough.** A 1.23 SOL DEPOSIT to Raydium AMM v4
  by itself tells you almost nothing; combined with mint authority +
  deployer history + pool age it becomes tradeable.

## 2. Entry signals (composable, AND-combined)

Each entry signal is a pure function `(pool, enrichment) => {ok, reason}`.

| id  | name                   | rule (default threshold)                                                     |
| --- | ---------------------- | ---------------------------------------------------------------------------- |
| E1  | first-liquidity        | event is INIT, or first DEPOSIT to an unseen pool                            |
| E2  | size-gate              | event SOL ≥ minSol (per-strategy override)                                   |
| E3  | mint sanity            | mintAuthority == null, freezeAuthority == null                               |
| E4  | LP locked/burned       | ≥ 95 % of LP tokens at burn address or locker                                |
| E5  | graduation             | source = pump.fun MIGRATE, age ≤ 60s                                         |
| E6  | deployer reputation    | deployer not in `data/blocklist.json`, has ≥ 1 prior non-rug or zero history |
| E7  | quote-token whitelist  | pool quote ∈ {WSOL, USDC, USDT}                                              |
| E8  | no concurrent dev dump | deployer sold ≤ X % in tx-block ± K slots                                    |

Cost of each check:

- E1, E2 — free (already in capture).
- E3, E4 — 1 `getAccountInfo` + 1 `getTokenLargestAccounts`.
- E5 — free (in log).
- E6 — 1 `getSignaturesForAddress` on deployer (cap at 50). Cacheable.
- E7 — free (in capture).
- E8 — scans recent slots; pricey. Skip in POC unless cheap path appears.

POC strategy: E1+E2+E3+E7 always; E4+E5 when applicable; E6 with cached
deployer history.

## 3. Exit signals (OR-combined, first to fire wins)

| id  | name               | rule                                                               |
| --- | ------------------ | ------------------------------------------------------------------ |
| X1  | take-profit ladder | sell 50 % @ +50 %, 25 % @ +100 %, 25 % runner                      |
| X2  | trailing stop      | drop from peak ≥ trailPct (default 25 %)                           |
| X3  | time stop          | exit after holdSec (default 30 min) if no other exit               |
| X4  | hard stop loss     | exit at ≤ −stopPct (default 30 %)                                  |
| X5  | liquidity drain    | pool SOL ≤ drainPct × baseline SOL (default 50 %)                  |
| X6  | dev/insider sell   | top-N holder (deployer or known insider) sells ≥ insiderPct (10 %) |
| X7  | momentum decay     | N consecutive 1-min samples with non-positive return + low volume  |

X1, X2, X3, X4 require only price-series snapshots — cheap. X5 requires
ongoing pool-reserve sampling (we already need this for price). X6 needs
holder-balance polling — moderate. X7 is derived from the same series.

## 4. Strategy profiles

Each profile picks an entry-rule set and an exit-rule set. Implemented in
`scripts/signals.ts` as named `Strategy` objects, evaluated by
`scripts/backtest.ts`.

### S1 — Pump.fun graduation sniper

- Entry: E1 ∧ E2(minSol=5) ∧ E5 ∧ E7
- Exit: X1 ∨ X2(20 %) ∨ X3(15 min) ∨ X4(30 %)
- Thesis: graduations have already cleared the pump.fun bonding curve
  (~$15k cap floor), so the floor risk is bounded. Fast TP / tight trail.

### S2 — Meteora DLMM size-gate

- Entry: E1 ∧ E2(minSol=25) ∧ E3 ∧ E7
- Exit: X2(25 %) ∨ X3(60 min) ∨ X4(35 %) ∨ X5(50 %)
- Thesis: the 50 SOL DLMM deposit observed in the user's log is the model
  trade. Larger initial liquidity = lower slippage, slower decay.

### S3 — Raydium AMM v4 fresh-pool

- Entry: E1(INIT only) ∧ E2(minSol=5) ∧ E3 ∧ E7
- Exit: X1 ∨ X2(25 %) ∨ X3(30 min) ∨ X4(30 %)
- Thesis: classic "new pool" trade. Highest-volume program; requires the
  strictest sanity filtering because rug rate is highest here too.

### S4 — Tiered multi-DEX

- Entry: E1 ∧ E3 ∧ E7; **position size** = f(event SOL):
  - 1 – 5 SOL pool → 0.1 SOL test buy
  - 5 – 25 SOL pool → 0.5 SOL standard
  - 25 + SOL pool → 1.0 SOL conviction
- Exit: X1 ∨ X2(25 %) ∨ X3(45 min) ∨ X4(30 %) ∨ X5(50 %)
- Thesis: small bets often, scaled by initial-liquidity signal. The
  per-tier sizing is the main hedge against rugs.

## 5. Backtests

Each backtest reads `data/pools.jsonl` + `data/prices.jsonl` +
`data/enrich/<mint>.json` and simulates fills at the price recorded one
sample after entry-signal fire (≈ next slot). Slippage and gas modelled as
flat constants for the POC.

| id  | name                  | inputs                                                               |
| --- | --------------------- | -------------------------------------------------------------------- |
| B1  | buy-and-hold baseline | E1∧E2 entry, X3-only exit (30/60/120 min) — establishes return floor |
| B2  | trailing-stop only    | strategy entry + X2 + X3 fallback                                    |
| B3  | ladder + trail        | strategy entry + X1 + X2 + X3 fallback                               |
| B4  | strategy bake-off     | S1, S2, S3, S4 each under B3 exits — primary deliverable             |

Reported metrics per run:

- n trades, hit rate (% with positive PnL)
- mean / median return, std-dev
- max drawdown, max single loss, max single win
- avg time-in-trade, median time-to-exit by exit reason
- per-exit-reason histogram

## 6. POC data model

JSONL files, append-only, one record per line. Schema (TypeScript) in
`scripts/lib/types.ts`.

```
data/
  pools.jsonl            # PoolEvent — every LP event the capture sees
  prices.jsonl           # PriceSnap — periodic pool-reserve sample
  enrich/<mint>.json     # MintEnrichment — one-shot enrichment per token
  trades.jsonl           # SimTrade — backtest output (entry/exit pairs)
  blocklist.json         # deployer addresses to skip
```

## 7. Out of scope for POC

- On-chain execution (sending swap txes). Backtest only.
- Jupiter / aggregator routing. AMM math used directly for fill simulation.
- TUI. Plain stdout.
- SQLite / time-series DB. JSONL is fine until > ~100k rows.
- Helius webhooks / Geyser. Stay on plain `onLogs` + `getParsedTransaction`.
