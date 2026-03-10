import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  ActionExample,
} from "@elizaos/core";
import { VincentMCPService } from "../services/VincentMCPService.js";
import {
  PMBetParamsSchema,
  MCP_TOOLS,
  PLUGIN_NAME,
} from "../types.js";
import type { PMBetParams, PMBetResponse, RiskAssessment } from "../types.js";

const examples: ActionExample[] = [
  [
    {
      name: "{{user1}}",
      content: { text: "Bet $50 YES on Trump winning 2028 election" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Placing a $50 YES bet on the Trump 2028 election market on Polymarket.",
        action: "BET_POLYMARKET",
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: { text: "Put 100 USDC on NO for Bitcoin hitting 200k by June" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Placing a $100 NO position on the BTC $200k by June market on Polymarket.",
        action: "BET_POLYMARKET",
      },
    },
  ],
];

export const betPolymarket: Action = {
  name: "BET_POLYMARKET",
  description:
    "Place a prediction market bet on Polymarket through Vincent delegated signing. " +
    "Supports natural language market descriptions or direct condition/token IDs. " +
    "All bets are policy-gated by the user's Vincent consent parameters.",
  similes: [
    "BET",
    "PREDICT",
    "PREDICTION",
    "POLYMARKET",
    "POLY",
    "WAGER",
    "PM_BET",
    "YES_NO",
    "PREDICTION_MARKET",
  ],
  examples,

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State
  ): Promise<boolean> => {
    const mcp = runtime.getService<VincentMCPService>("vincent-mcp");
    if (!mcp || !mcp.isConnected() || !mcp.isSessionValid()) return false;

    const text = (message.content?.text ?? "").toLowerCase();
    const keywords = [
      "bet",
      "predict",
      "polymarket",
      "poly",
      "wager",
      "yes",
      "no",
      "outcome",
      "market",
      "probability",
      "odds",
    ];
    return keywords.some((kw) => text.includes(kw));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const mcp = runtime.getService<VincentMCPService>("vincent-mcp");
    if (!mcp) {
      await callback({
        text: "Vincent MCP service is not available.",
        action: "BET_POLYMARKET",
      });
      return { success: false, error: "MCP service unavailable" };
    }

    // ── Step 1: Extract bet parameters via LLM ─────────────────────
    let params: PMBetParams;
    try {
      const extraction = await runtime.useModel("object_large" as any, {
        prompt: `Extract Polymarket bet parameters from this message:\n"${message.content.text}"\n\nReturn JSON with: marketQuery (string, natural language description of the market or a condition ID), side ("YES" or "NO"), size (number, USDC amount), orderType ("GTC", "GTD", or "FOK", default "GTC").`,
        schema: PMBetParamsSchema,
      });
      params = extraction as PMBetParams;
    } catch {
      await callback({
        text: "I couldn't parse the bet parameters. Please specify the market, side (YES/NO), and amount in USDC.",
        action: "BET_POLYMARKET",
      });
      return { success: false, error: "Parameter extraction failed" };
    }

    // ── Step 2: Pre-flight risk assessment ─────────────────────────
    try {
      const risk = await mcp.callTool<RiskAssessment>(
        "vincent-risk-check",
        {
          venue: "polymarket",
          marketQuery: params.marketQuery,
          side: params.side,
          sizeUsd: params.size,
          orderType: params.orderType,
        }
      );

      if (risk.verdict === "block") {
        await callback({
          text:
            `Bet blocked by policy: ${risk.reasons.join("; ")}. ` +
            `Update your Vincent consent parameters to proceed.`,
          action: "BET_POLYMARKET",
        });
        return { success: false, data: { risk }, error: "Policy block" };
      }

      if (risk.verdict === "warn" && risk.requiresConfirmation) {
        await callback({
          text:
            `⚠ Policy warnings:\n` +
            risk.warnings.map((w) => `• ${w.message}`).join("\n") +
            `\nProceed? Reply "confirm" to execute.`,
          action: "BET_POLYMARKET",
        });
      }
    } catch {
      // Best-effort; Vincent Lit Action is the true enforcer
    }

    // ── Step 3: Execute via MCP tool ───────────────────────────────
    try {
      const response = await mcp.callTool<PMBetResponse>(
        MCP_TOOLS.PM_PREDICTION,
        {
          marketQuery: params.marketQuery,
          side: params.side,
          size: params.size,
          orderType: params.orderType,
        }
      );

      if (response.success) {
        const summary = [
          `Bet placed on Polymarket:`,
          response.marketQuestion
            ? `• Market: "${response.marketQuestion}"`
            : `• Query: "${params.marketQuery}"`,
          `• Side: ${params.side} — $${params.size} USDC`,
          response.fillPrice
            ? `• Fill price: $${response.fillPrice.toFixed(4)}`
            : null,
          response.status ? `• Status: ${response.status}` : null,
          response.remainingDailyBudgetUsd != null
            ? `• Remaining daily budget: $${response.remainingDailyBudgetUsd.toLocaleString()}`
            : null,
        ]
          .filter(Boolean)
          .join("\n");

        await callback({ text: summary, action: "BET_POLYMARKET" });

        await runtime.createMemory(
          {
            entityId: message.entityId,
            roomId: message.roomId,
            content: {
              text: summary,
              metadata: {
                type: "pm_bet",
                params,
                response,
                timestamp: Date.now(),
              },
            },
          } as any,
          "trades"
        );

        return { success: true, data: { params, response } };
      }

      await callback({
        text: `Bet failed: ${response.error ?? "Unknown error from Polymarket"}`,
        action: "BET_POLYMARKET",
      });
      return { success: false, data: { response }, error: response.error };
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "MCP communication error";
      await callback({
        text: `Bet execution error: ${msg}`,
        action: "BET_POLYMARKET",
      });
      return { success: false, error: msg };
    }
  },
};

export default betPolymarket;
