/**
 * DEX / launchpad registry — shared by every script in scripts/.
 *
 * Each event has one or more `signatures` — case-insensitive substrings
 * the program emits inside its logs when that instruction fires. Anchor
 * programs emit `Program log: Instruction: <Name>`; legacy programs
 * (Raydium AMM v4, pump.fun) emit snake_case discriminator strings.
 *
 * Adding a new program: pick a known event tx on Solscan, copy the log
 * line unique to that instruction, drop the unique substring in here.
 */

export type EventType = "INIT" | "DEPOSIT" | "MIGRATE" | "CREATE";

export interface EventRule {
  type: EventType;
  signatures: string[];
}

export interface DexEntry {
  key: string;
  name: string;
  programId: string;
  events: EventRule[];
}

export const DEXES: DexEntry[] = [
  {
    key: "raydium-amm",
    name: "Raydium AMM v4",
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    events: [
      { type: "INIT", signatures: ["initialize2", "init_pc_amount"] },
      { type: "DEPOSIT", signatures: ["Instruction: Deposit", "ray_log"] },
    ],
  },
  {
    key: "raydium-cpmm",
    name: "Raydium CPMM",
    programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    events: [
      { type: "INIT", signatures: ["Instruction: Initialize", "Instruction: CreatePool"] },
      { type: "DEPOSIT", signatures: ["Instruction: Deposit"] },
    ],
  },
  {
    key: "raydium-clmm",
    name: "Raydium CLMM",
    programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    events: [
      { type: "INIT", signatures: ["Instruction: CreatePool"] },
      {
        type: "DEPOSIT",
        signatures: [
          "Instruction: OpenPosition",
          "Instruction: OpenPositionWithToken22Nft",
          "Instruction: IncreaseLiquidity",
        ],
      },
    ],
  },
  {
    key: "orca-whirlpool",
    name: "Orca Whirlpool",
    programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    events: [
      {
        type: "INIT",
        signatures: ["Instruction: InitializePool", "Instruction: InitializePoolV2"],
      },
      {
        type: "DEPOSIT",
        signatures: ["Instruction: IncreaseLiquidity", "Instruction: IncreaseLiquidityV2"],
      },
    ],
  },
  {
    key: "meteora-dlmm",
    name: "Meteora DLMM",
    programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    events: [
      {
        type: "INIT",
        signatures: ["Instruction: InitializeLbPair", "Instruction: InitializePermissionLbPair"],
      },
      {
        type: "DEPOSIT",
        signatures: [
          "Instruction: AddLiquidity",
          "Instruction: AddLiquidityByStrategy",
          "Instruction: AddLiquidityByStrategy2",
        ],
      },
    ],
  },
  {
    key: "meteora-damm-v2",
    name: "Meteora DAMM v2",
    programId: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    events: [
      {
        type: "INIT",
        signatures: [
          "Instruction: InitializePool",
          "Instruction: InitializeCustomizablePool",
          "Instruction: CreatePool",
        ],
      },
      { type: "DEPOSIT", signatures: ["Instruction: AddLiquidity"] },
    ],
  },
  {
    key: "pumpfun",
    name: "Pump.fun",
    programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    events: [
      { type: "CREATE", signatures: ["create_v2", "Instruction: CreateV2", "Instruction: Create"] },
      {
        type: "MIGRATE",
        signatures: ["migrate_v2", "Instruction: MigrateV2", "Instruction: Migrate"],
      },
    ],
  },
  {
    key: "pumpswap",
    name: "PumpSwap AMM",
    programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    events: [
      { type: "INIT", signatures: ["Instruction: CreatePool", "create_pool"] },
      { type: "DEPOSIT", signatures: ["Instruction: Deposit"] },
    ],
  },
];

export const DEX_BY_KEY: Record<string, DexEntry> = Object.fromEntries(
  DEXES.map((d) => [d.key, d]),
);
export const DEX_BY_PROGRAM: Record<string, DexEntry> = Object.fromEntries(
  DEXES.map((d) => [d.programId, d]),
);

export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const USD1 = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
export const STABLE_MINTS = new Set([WSOL, USDC, USDT, USD1]);
export const BURN_ADDRESSES = new Set([
  "11111111111111111111111111111111",
  "1nc1nerator11111111111111111111111111111111",
  "deadbeefDeAdBEEFDEADbEEFDeADBEefdEaDBEEFDEAd",
]);
