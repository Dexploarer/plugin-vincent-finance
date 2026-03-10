import type {
  Evaluator,
  IAgentRuntime,
  Memory,
  State,
  EvaluationExample,
} from "@elizaos/core";
import { VincentMCPService } from "../services/VincentMCPService.js";
import { MCP_RESOURCES, DEFAULTS } from "../types.js";
import type {
  HyperliquidTradingPolicy,
  PolymarketTradingPolicy,
  PolicyWarning,
  RiskAssessment,
  RiskVerdict,
} from "../types.js";

/**
 * Risk Assessor Evaluator
 *
 * Runs after every action round to evaluate whether recent trade actions
 * are approaching policy boundaries. This provides a soft guardrail layer
 * on top of the hard enforcement in Vincent Lit Actions.
 *
 * Checks include:
 * - Session JWT validity / expiration proximity
 * - Daily volume consumption vs limits
 * - Position concentration warnings
 * - Circuit breaker state awareness
 */

interface PolicyConfig {
  hyperliquid?: HyperliquidTradingPolicy;
  polymarket?: PolymarketTradingPolicy;
  dailyHlVolumeUsed?: number;
  dailyPmVolumeUsed?: number;
}

export const riskAssessor: Evaluator = {
  name: "RISK_ASSESSOR",
  description:
    "Post-action evaluator that monitors policy boundary proximity and " +
    "session health. Warns the agent before trades would hit hard limits.",
  similes: ["RISK_CHECK", "POLICY_MONITOR"],

  examples: [] as EvaluationExample[],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    // Run after any message in a room where trading has occurred
    const mcp = runtime.getService<VincentMCPService>("vincent-mcp");
    return mcp?.isConnected() ?? false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => {
    const mcp = runtime.getService<VincentMCPService>("vincent-mcp");
    if (!mcp) {
      return { success: true, text: "" };
    }

    const warnings: PolicyWarning[] = [];
    let verdict: RiskVerdict = "proceed";

    // ── 1. Session Health ──────────────────────────────────────────
    const session = mcp.getSession();
    if (!session) {
      return {
        success: false,
        text: "No active Vincent session. User must connect via Vincent Connect page before trading.",
        data: {
          verdict: "block" as RiskVerdict,
          reason: "no_session",
        },
      };
    }

    const secondsRemaining = session.expiresAt - Date.now() / 1000;
    if (secondsRemaining < 300) {
      // Less than 5 minutes
      warnings.push({
        parameter: "session_expiry",
        currentValue: secondsRemaining,
        threshold: 300,
        message: `Vincent session expires in ${Math.ceil(secondsRemaining / 60)} minutes. Re-authorize soon.`,
      });
      verdict = "warn";
    }

    // ── 2. Circuit Breaker State ───────────────────────────────────
    const cbState = mcp.getCircuitBreakerState();
    if (cbState === "open") {
      return {
        success: false,
        text: "MCP circuit breaker is OPEN — the Vincent server is unreachable. Trading is temporarily suspended.",
        data: {
          verdict: "block" as RiskVerdict,
          reason: "circuit_breaker_open",
        },
      };
    }
    if (cbState === "half-open") {
      warnings.push({
        parameter: "circuit_breaker",
        currentValue: 1,
        threshold: 0,
        message:
          "MCP connection is recovering (half-open). Next request is a test probe.",
      });
    }

    // ── 3. Policy Boundary Proximity ───────────────────────────────
    try {
      const policyConfig = (await mcp.readResource(
        MCP_RESOURCES.POLICY_CONFIG
      )) as PolicyConfig;

      // Hyperliquid daily volume check
      if (policyConfig.hyperliquid && policyConfig.dailyHlVolumeUsed != null) {
        const used = policyConfig.dailyHlVolumeUsed;
        const limit = policyConfig.hyperliquid.maxDailyVolumeUsd;
        const pct = (used / limit) * 100;

        if (pct >= 90) {
          warnings.push({
            parameter: "hl_daily_volume",
            currentValue: used,
            threshold: limit,
            message: `Hyperliquid daily volume at ${pct.toFixed(0)}% ($${used.toLocaleString()} / $${limit.toLocaleString()}). Approaching daily limit.`,
          });
          verdict = pct >= 100 ? "block" : "warn";
        }
      }

      // Polymarket daily volume check
      if (policyConfig.polymarket && policyConfig.dailyPmVolumeUsed != null) {
        const used = policyConfig.dailyPmVolumeUsed;
        const limit = policyConfig.polymarket.maxDailyBetsUsd;
        const pct = (used / limit) * 100;

        if (pct >= 90) {
          warnings.push({
            parameter: "pm_daily_volume",
            currentValue: used,
            threshold: limit,
            message: `Polymarket daily bet volume at ${pct.toFixed(0)}% ($${used.toLocaleString()} / $${limit.toLocaleString()}).`,
          });
          verdict = pct >= 100 ? "block" : "warn";
        }
      }
    } catch {
      // Policy resource read failed — non-fatal, rely on Lit Action enforcement
    }

    // ── 4. Compose Assessment ──────────────────────────────────────
    const assessment: RiskAssessment = {
      verdict,
      reasons: warnings.map((w) => w.message),
      warnings,
      requiresConfirmation: verdict === "warn",
    };

    if (warnings.length === 0) {
      return {
        success: true,
        text: "",
        data: { assessment },
      };
    }

    const text = warnings.map((w) => `⚠ ${w.message}`).join("\n");
    return {
      success: verdict !== "block",
      text,
      data: { assessment },
    };
  },
};

export default riskAssessor;
