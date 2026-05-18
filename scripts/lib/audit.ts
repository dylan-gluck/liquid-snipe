/**
 * Audit logging — structured lifecycle events with traceId linkage.
 * Every trade lifecycle step is logged for post-mortem analysis.
 */

import { log } from "./logger.ts";
import type { AppConfig } from "./config.ts";

// ─── AuditLog ──────────────────────────────────────────────────────

export class AuditLog {
  private readonly component;

  constructor(_config: AppConfig) {
    this.component = log.child({ component: "audit" });
  }

  logDetection(
    traceId: string,
    pool: {
      txSignature: string;
      dexKey: string;
      solValue: number;
      detectedAt?: number;
    },
  ): void {
    this.component.info("pool_detected", {
      traceId,
      txSignature: pool.txSignature,
      dexKey: pool.dexKey,
      solValue: pool.solValue,
      detectedAt: pool.detectedAt ?? Date.now(),
    });
  }

  logSafetyCheck(
    traceId: string,
    verdict: {
      pass: boolean;
      totalDurationMs: number;
      checks: Array<{ name: string; pass: boolean }>;
    },
  ): void {
    this.component.info("safety_check", {
      traceId,
      pass: verdict.pass,
      totalDurationMs: verdict.totalDurationMs,
      failedChecks: verdict.checks.filter((c) => !c.pass).map((c) => c.name),
      checkCount: verdict.checks.length,
    });
  }

  logDecision(
    traceId: string,
    decision: {
      fire: boolean;
      strategyId: string;
      reasons: string[];
      blocked?: string;
    },
  ): void {
    this.component.info("decision", {
      traceId,
      fire: decision.fire,
      strategyId: decision.strategyId,
      reasons: decision.reasons,
      ...(decision.blocked != null ? { blocked: decision.blocked } : {}),
    });
  }

  logTxAttempt(
    traceId: string,
    attempt: {
      id: string;
      kind: string;
      status: string;
      sig?: string | null;
      error?: string | null;
    },
  ): void {
    this.component.info("tx_attempt", {
      traceId,
      attemptId: attempt.id,
      kind: attempt.kind,
      status: attempt.status,
      ...(attempt.sig != null ? { sig: attempt.sig } : {}),
      ...(attempt.error != null ? { error: attempt.error } : {}),
    });
  }

  logPositionClose(
    traceId: string,
    close: {
      positionId: string;
      reason: string;
      pnlSol?: number;
    },
  ): void {
    this.component.info("position_close", {
      traceId,
      positionId: close.positionId,
      reason: close.reason,
      ...(close.pnlSol != null ? { pnlSol: close.pnlSol } : {}),
    });
  }

  logAlert(level: string, message: string, extra?: Record<string, unknown>): void {
    this.component.info("alert", {
      alertLevel: level,
      message,
      ...(extra != null ? extra : {}),
    });
  }
}

// ─── Webhook alerting ──────────────────────────────────────────────

export async function sendWebhookAlert(
  webhookUrl: string,
  payload: {
    level: string;
    message: string;
    timestamp: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn("webhook_alert_failed", {
          status: res.status,
          url: webhookUrl,
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log.error("webhook_alert_error", {
      error: err instanceof Error ? err.message : String(err),
      url: webhookUrl,
    });
  }
}
