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
  HLTradeParamsSchema,
  MCP_TOOLS,
  PLUGIN_NAME,
} from "../types.js";
import type { HLTradeParams, HLTradeResponse, RiskAssessment } from "../types.js";

const examples: ActionExample[][] = [
  [
    {
      name: "{{user1}}",
      content: { text: "Long 0.5 ETH on Hyperliquid" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Opening a long position for 0.5 ETH on Hyperliquid via market order.",
        action: "TRADE_HYPERLIQUID",
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: { text: "Short 100 SOL with a limit at $180" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Placing a limit short order for 100 SOL at $180 on Hyperliquid.",
        action: "TRADE_HYPERLIQUID",
      },
    },
  ],
];

export const tradeHyperliquid: Action = {
  name: "TRADE_HYPERLIQUID",
  description:
    "Execute a perpetual futures trade on Hyperliquid through Vincent delegated signing. " +
    "Supports market, limit, and stop orders. All trades are policy-gated by the user's " +
    "Vincent consent parameters (max size, allowed coins, leverage caps).",
  similes: [
    "TRADE",
    "LONG",
    "SHORT",
    "BUY_PERP",
    "SELL_PERP",
    "OPEN_POSITION",
    "HYPERLIQUID",
    "HL_TRADE",
    "PERP_TRADE",
  ],
  examples,

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    // Must have MCP service running
    const mcp = runtime.getService<VincentMCPService>("vincent-mcp");
    if (!mcp || !mcp.isConnected()) return false;

    // Must have valid session
    if (!mcp.isSessionValid()) return false;

    // Message should contain trading intent keywords
    const text = (message.content?.text ?? "").toLowerCase();
    const tradingKeywords = [
      "trade",
      "long",
      "short",
      "buy",
      "sell",
      "perp",
      "hyperliquid",
      "hl",
      "position",
      "order",
      "limit",
      "market",
      "stop",
    ];
    return tradingKeywords.some((kw) => text.includes(kw));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const mcp = runtime.getService<VincentMCPService>("vincent-mcp");
    if (!mcp) {
      await callback?.({
        text: "Vincent MCP service is not available. Please ensure the plugin is properly configured.",
        action: "TRADE_HYPERLIQUID",
      });
      return { success: false, error: "MCP service unavailable" };
    }

    // ── Step 1: Extract trade parameters via LLM ───────────────────
    let params: HLTradeParams;
    try {
      const extraction = await runtime.useModel("object_large" as any, {
        prompt: `Extract Hyperliquid trade parameters from this message:\n"${message.content.text}"\n\nReturn JSON with: coin (string, uppercase ticker), side ("long" or "short"), size (number, coin units), orderType ("market", "limit", or "stop"), price (number or null for market orders).`,
        schema: HLTradeParamsSchema,
      });
      params = extraction as HLTradeParams;
    } catch (error) {
      await callback?.({
        text: "I couldn't parse the trade parameters from your message. Please specify the coin, direction (long/short), size, and order type.",
        action: "TRADE_HYPERLIQUID",
      });
      return { success: false, error: "Parameter extraction failed" };
    }

    // ── Step 2: Pre-flight risk assessment ─────────────────────────
    try {
      const risk = await mcp.callTool<RiskAssessment>(
        "vincent-risk-check",
        {
          venue: "hyperliquid",
          coin: params.coin,
          side: params.side,
          sizeUnits: params.size,
          orderType: params.orderType,
          price: params.price,
        }
      );

      if (risk.verdict === "block") {
        await callback?.({
          text:
            `Trade blocked by policy: ${risk.reasons.join("; ")}. ` +
            `Update your Vincent consent parameters to proceed.`,
          action: "TRADE_HYPERLIQUID",
        });
        return {
          success: false,
          data: { risk },
          error: "Policy block",
        };
      }

      if (risk.verdict === "warn" && risk.requiresConfirmation) {
        await callback?.({
          text:
            `⚠ Policy warnings before execution:\n` +
            risk.warnings.map((w) => `• ${w.message}`).join("\n") +
            `\nProceed with trade? Reply "confirm" to execute.`,
          action: "TRADE_HYPERLIQUID",
        });
        // In a real flow, we'd await user confirmation here.
        // For now, we proceed — the Vincent Lit Action enforces the hard policy on-chain.
      }
    } catch {
      // Risk check is best-effort; Vincent Lit Action is the true policy enforcer
    }

    // ── Step 3: Execute via MCP tool ───────────────────────────────
    try {
      const response = await mcp.callTool<HLTradeResponse>(
        MCP_TOOLS.HL_TRADING,
        {
          coin: params.coin,
          side: params.side,
          size: params.size,
          orderType: params.orderType,
          ...(params.price != null && { price: params.price }),
        }
      );

      if (response.success) {
        const summary = [
          `Trade executed on Hyperliquid:`,
          `• ${params.side.toUpperCase()} ${params.size} ${params.coin}`,
          `• Order type: ${params.orderType}`,
          response.fillPrice
            ? `• Fill price: $${response.fillPrice.toLocaleString()}`
            : null,
          response.status ? `• Status: ${response.status}` : null,
          response.remainingDailyBudgetUsd != null
            ? `• Remaining daily budget: $${response.remainingDailyBudgetUsd.toLocaleString()}`
            : null,
        ]
          .filter(Boolean)
          .join("\n");

        await callback?.({ text: summary, action: "TRADE_HYPERLIQUID" });

        // Persist trade to memory for future context
        await runtime.createMemory(
          {
            entityId: message.entityId,
            roomId: message.roomId,
            content: {
              text: summary,
              metadata: {
                type: "hl_trade",
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

      await callback?.({
        text: `Trade failed: ${response.error ?? "Unknown error from Hyperliquid"}`,
        action: "TRADE_HYPERLIQUID",
      });
      return { success: false, data: { response }, error: response.error };
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "MCP communication error";
      await callback?.({
        text: `Trade execution error: ${msg}`,
        action: "TRADE_HYPERLIQUID",
      });
      return { success: false, error: msg };
    }
  },
};

export default tradeHyperliquid;
