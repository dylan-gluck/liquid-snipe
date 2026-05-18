/**
 * Jupiter v6 API client — quote + swap-instructions.
 */

import { log } from "./logger.ts";

const logger = log.child({ component: "jupiter" });

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

export async function jupiterQuote(
  apiUrl: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number,
  maxPriceImpactPct = 5,
): Promise<JupiterQuote | null> {
  const url = `${apiUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn("jupiter quote failed", { status: resp.status, url });
      return null;
    }
    const quote = (await resp.json()) as JupiterQuote;

    const impact = parseFloat(quote.priceImpactPct);
    if (impact > maxPriceImpactPct) {
      logger.warn("jupiter quote price impact too high", { impact, max: maxPriceImpactPct });
      return null;
    }

    return quote;
  } catch (err) {
    logger.error("jupiter quote error", { error: String(err) });
    return null;
  }
}

export interface JupiterSwapInstructions {
  setupInstructions: unknown[];
  swapInstruction: unknown;
  cleanupInstruction: unknown;
  addressLookupTableAddresses: string[];
}

export async function jupiterSwapInstructions(
  apiUrl: string,
  quote: JupiterQuote,
  userPublicKey: string,
): Promise<JupiterSwapInstructions | null> {
  const url = `${apiUrl}/swap-instructions`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    });
    if (!resp.ok) {
      logger.warn("jupiter swap-instructions failed", { status: resp.status });
      return null;
    }
    return (await resp.json()) as JupiterSwapInstructions;
  } catch (err) {
    logger.error("jupiter swap-instructions error", { error: String(err) });
    return null;
  }
}
