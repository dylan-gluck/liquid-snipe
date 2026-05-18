/**
 * Jito bundle submission via block-engine REST API.
 */

import { log } from "./logger.ts";
import { encode as bs58Encode } from "bs58";

const logger = log.child({ component: "jito" });

export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bPuS3JFNUMhLACp2Gs4g58",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSADv6wrLNev8d7iJTDi",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

export function randomTipAccount(): string {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
}

export interface JitoBundleResult {
  bundleId: string;
  accepted: boolean;
  error?: string;
}

export async function submitJitoBundle(
  blockEngineUrl: string,
  serializedTxs: Uint8Array[],
  _tipLamports: number,
): Promise<JitoBundleResult> {
  const encoded = serializedTxs.map((tx) => bs58Encode(tx));

  try {
    const resp = await fetch(`${blockEngineUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [encoded],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.warn("jito bundle rejected", { status: resp.status, body });
      return { bundleId: "", accepted: false, error: `HTTP ${resp.status}: ${body}` };
    }

    const json = (await resp.json()) as { result?: string; error?: { message: string } };

    if (json.error) {
      logger.warn("jito bundle error", { error: json.error.message });
      return { bundleId: "", accepted: false, error: json.error.message };
    }

    const bundleId = json.result ?? "";
    logger.info("jito bundle accepted", { bundleId });
    return { bundleId, accepted: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("jito bundle submission failed", { error: message });
    return { bundleId: "", accepted: false, error: message };
  }
}
