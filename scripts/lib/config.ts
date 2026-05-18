/**
 * YAML config loader — loads config.yaml (or CONFIG_PATH env) + merges
 * config.local.yaml overrides. Validates with Zod.
 *
 * Supports ${ENV_VAR} interpolation in string values.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";
import { log } from "./logger.ts";

// ─── Schema ────────────────────────────────────────────────────────

const RpcConfigSchema = z.object({
  heliusApiKey: z.string().optional(),
  httpUrls: z.array(z.string()).default(["https://api.mainnet-beta.solana.com"]),
  wsUrl: z.string().default("wss://api.mainnet-beta.solana.com"),
  grpcUrl: z.string().optional(),
  grpcToken: z.string().optional(),
  commitment: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
  maxSlotLag: z.number().int().default(5),
});

const WalletConfigSchema = z.object({
  keypairPaths: z.array(z.string()).default([]),
  minBalanceSol: z.number().default(0.05),
});

const ExitConfigSchema = z.object({
  ladderRungs: z.array(z.object({ profit: z.number(), sell: z.number() })).optional(),
  trailPct: z.number().optional(),
  holdSec: z.number().optional(),
  stopPct: z.number().optional(),
  drainPct: z.number().optional(),
  decayN: z.number().int().optional(),
});

const StrategyConfigSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  minSol: z.number().default(1),
  allowedTypes: z.array(z.string()).optional(),
  allowedDexes: z.array(z.string()).optional(),
  requireMintSanity: z.boolean().default(true),
  requireGraduation: z.boolean().default(false),
  maxDeployerPriorLaunches: z.number().int().optional(),
  allowedQuoteMints: z.array(z.string()).optional(),
  sizeSol: z.number().default(0.5),
  sizeByLiquidity: z.array(z.object({ minSol: z.number(), size: z.number() })).optional(),
  maxSlippageBps: z.number().int().default(250),
  maxFeeLamports: z.number().int().default(100_000),
  maxSimultaneousPositions: z.number().int().default(3),
  exit: ExitConfigSchema.default({}),
});

const RiskConfigSchema = z.object({
  dailyMaxLossSol: z.number().default(5),
  maxSimFailures: z.number().int().default(3),
  maxRpcErrorRate: z.number().default(0.05),
  maxSlotLag: z.number().int().default(5),
  perBlockCapSol: z.number().default(2),
});

const AlertConfigSchema = z.object({
  webhookUrl: z.string().optional(),
  enabled: z.boolean().default(false),
});

const KillSwitchConfigSchema = z.object({
  hmacSecret: z.string().optional(),
  haltFilePath: z.string().default("data/HALT"),
});

const DatabaseConfigSchema = z.object({
  path: z.string().default("data/liquid-snipe.db"),
});

const MetricsConfigSchema = z.object({
  port: z.number().int().default(9090),
  enabled: z.boolean().default(true),
});

const JitoConfigSchema = z.object({
  blockEngineUrl: z.string().default("https://mainnet.block-engine.jito.wtf"),
  tipLamports: z.number().int().default(10_000),
  enabled: z.boolean().default(true),
});

const JupiterConfigSchema = z.object({
  apiUrl: z.string().default("https://quote-api.jup.ag/v6"),
  maxPriceImpactPct: z.number().default(5),
});

// Pre-compute defaults by parsing {} through each sub-schema (all fields have defaults).
const rpcDefaults = RpcConfigSchema.parse({});
const walletDefaults = WalletConfigSchema.parse({});
const riskDefaults = RiskConfigSchema.parse({});
const alertDefaults = AlertConfigSchema.parse({});
const killswitchDefaults = KillSwitchConfigSchema.parse({});
const dbDefaults = DatabaseConfigSchema.parse({});
const metricsDefaults = MetricsConfigSchema.parse({});
const jitoDefaults = JitoConfigSchema.parse({});
const jupiterDefaults = JupiterConfigSchema.parse({});

export const AppConfigSchema = z.object({
  rpc: RpcConfigSchema.default(rpcDefaults),
  wallet: WalletConfigSchema.default(walletDefaults),
  strategies: z.array(StrategyConfigSchema).default([]),
  risk: RiskConfigSchema.default(riskDefaults),
  alerts: AlertConfigSchema.default(alertDefaults),
  killswitch: KillSwitchConfigSchema.default(killswitchDefaults),
  database: DatabaseConfigSchema.default(dbDefaults),
  metrics: MetricsConfigSchema.default(metricsDefaults),
  jito: JitoConfigSchema.default(jitoDefaults),
  jupiter: JupiterConfigSchema.default(jupiterDefaults),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
export type ExitCfg = z.infer<typeof ExitConfigSchema>;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

// ─── Env interpolation ─────────────────────────────────────────────

function interpolateEnv(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      return process.env[name] ?? "";
    });
  }
  if (Array.isArray(obj)) return obj.map(interpolateEnv);
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = interpolateEnv(v);
    }
    return out;
  }
  return obj;
}

// ─── Loader ────────────────────────────────────────────────────────

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const bv = base[key];
    const ov = override[key];
    if (
      bv &&
      ov &&
      typeof bv === "object" &&
      typeof ov === "object" &&
      !Array.isArray(bv) &&
      !Array.isArray(ov)
    ) {
      result[key] = deepMerge(bv as Record<string, unknown>, ov as Record<string, unknown>);
    } else {
      result[key] = ov;
    }
  }
  return result;
}

let _cached: AppConfig | null = null;

export function loadConfig(configPath?: string): AppConfig {
  if (_cached) return _cached;

  const primary = configPath ?? process.env.CONFIG_PATH ?? "config.yaml";
  let raw: Record<string, unknown> = {};

  if (existsSync(primary)) {
    const text = readFileSync(primary, "utf8");
    raw = (parseYaml(text) as Record<string, unknown>) ?? {};
    log.info("loaded config", { path: primary });
  } else if (!configPath) {
    // Fall back to config.example.yaml for dev
    const example = "config.example.yaml";
    if (existsSync(example)) {
      const text = readFileSync(example, "utf8");
      raw = (parseYaml(text) as Record<string, unknown>) ?? {};
      log.info("loaded config from example", { path: example });
    } else {
      log.warn("no config file found, using defaults");
    }
  } else {
    throw new Error(`Config file not found: ${primary}`);
  }

  // Merge local overrides
  const localPath = "config.local.yaml";
  if (existsSync(localPath)) {
    const localText = readFileSync(localPath, "utf8");
    const localRaw = (parseYaml(localText) as Record<string, unknown>) ?? {};
    raw = deepMerge(raw, localRaw);
    log.info("merged local config", { path: localPath });
  }

  // Env interpolation
  raw = interpolateEnv(raw) as Record<string, unknown>;

  const result = AppConfigSchema.parse(raw);
  _cached = result;
  return result;
}

/** Reset the cached config (for tests). */
export function resetConfigCache(): void {
  _cached = null;
}
