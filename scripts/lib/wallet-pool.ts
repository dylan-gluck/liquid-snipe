/**
 * Hot wallet round-robin with balance gating.
 */

import { Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { log } from "./logger.ts";

const BALANCE_CACHE_MS = 60_000;

interface WalletEntry {
  keypair: Keypair;
  cachedBalance: number;
  lastChecked: number;
}

export class WalletPool {
  private readonly wallets: WalletEntry[];
  private readonly minBalanceLamports: number;
  private index = 0;
  private readonly logger = log.child({ component: "wallet-pool" });

  constructor(keypairPaths: string[], minBalanceSol: number) {
    this.minBalanceLamports = minBalanceSol * LAMPORTS_PER_SOL;
    this.wallets = keypairPaths.map((p) => {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as number[];
      const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
      this.logger.info("loaded wallet", { pubkey: keypair.publicKey.toBase58(), path: p });
      return { keypair, cachedBalance: Infinity, lastChecked: 0 };
    });
    if (this.wallets.length === 0) {
      this.logger.warn("no keypairs loaded — wallet pool is empty");
    }
  }

  async getNextKeypair(connection: Connection, _strategyId?: string): Promise<Keypair | null> {
    const n = this.wallets.length;
    if (n === 0) return null;

    const now = Date.now();

    for (let i = 0; i < n; i++) {
      const idx = this.index % n;
      this.index++;
      const entry = this.wallets[idx]!;

      if (now - entry.lastChecked > BALANCE_CACHE_MS) {
        try {
          entry.cachedBalance = await connection.getBalance(entry.keypair.publicKey);
          entry.lastChecked = now;
        } catch (err) {
          this.logger.warn("balance check failed, skipping", {
            pubkey: entry.keypair.publicKey.toBase58(),
            error: String(err),
          });
          continue;
        }
      }

      if (entry.cachedBalance >= this.minBalanceLamports) {
        return entry.keypair;
      }

      this.logger.debug("wallet below min balance, skipping", {
        pubkey: entry.keypair.publicKey.toBase58(),
        balance: entry.cachedBalance / LAMPORTS_PER_SOL,
      });
    }

    this.logger.warn("all wallets below minimum balance");
    return null;
  }

  getKeypairs(): Keypair[] {
    return this.wallets.map((w) => w.keypair);
  }

  size(): number {
    return this.wallets.length;
  }
}
