import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  ActionExample,
} from "@elizaos/core";
import { VincentMCPService } from "../services/VincentMCPService.js";
import { MCP_TOOLS } from "../types.js";
import type {
  HLAccountSummary,
  PMAccountSummary,
  CrossVenuePortfolio,
} from "../types.js";

const examples: ActionExample[] = [
  [
    {
      name: "{{user1}}",
      content: { text: "Show me my positions" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Here's your cross-venue portfolio summary across Hyperliquid and Polymarket.",
        action: "CHECK_POSITIONS",
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: { text: "What's my P&L?" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Fetching your current P&L across both venues.",
        action: "CHECK_POSITIONS",
      },
    },
  ],
];

export const checkPositions: Action = {
  name: "CHECK_POSITIONS",
  description:
    "Query open positions and P&L across both Hyperliquid (perpetuals) and " +
    "Polymarket (prediction markets). Returns a unified cross-venue portfolio view.",
  similes: [
    "POSITIONS",
    "PORTFOLIO",
    "PNL",
    "P&L",
    "BALANCE",
    "HOLDINGS",
    "CHECK_PORTFOLIO",
    "ACCOUNT",
    "STATUS",
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
      "position",
      "portfolio",
      "pnl",
      "p&l",
      "balance",
      "holding",
      "account",
      "equity",
      "status",
      "how am i doing",
      "unrealized",
    ];
    return keywords.some((kw) => text.includes(kw));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const mcp = runtime.getService<VincentMCPService>("vincent-mcp");
    if (!mcp) {
      await callback({
        text: "Vincent MCP service is not available.",
        action: "CHECK_POSITIONS",
      });
      return { success: false, error: "MCP service unavailable" };
    }

    try {
      // Query both venues in parallel
      const [hlData, pmData] = await Promise.all([
        mcp
          .callTool<HLAccountSummary>(MCP_TOOLS.HL_TRADING, {
            action: "get_positions",
          })
          .catch(() => null),
        mcp
          .callTool<PMAccountSummary>(MCP_TOOLS.PM_MONITOR, {
            action: "get_positions",
          })
          .catch(() => null),
      ]);

      // Build cross-venue portfolio
      const hlEquity = hlData?.equity ?? 0;
      const hlPnl = hlData?.positions?.reduce(
        (sum, p) => sum + p.unrealizedPnl,
        0
      ) ?? 0;

      const pmInvested = pmData?.totalInvested ?? 0;
      const pmUnrealized = pmData?.openPositions?.reduce(
        (sum, p) => sum + p.unrealizedPnl,
        0
      ) ?? 0;

      const lines: string[] = ["**Cross-Venue Portfolio**\n"];

      // Hyperliquid section
      if (hlData) {
        lines.push(`**Hyperliquid**`);
        lines.push(`• Equity: $${hlEquity.toLocaleString()}`);
        lines.push(
          `• Effective leverage: ${hlData.effectiveLeverage?.toFixed(2) ?? "N/A"}x`
        );
        if (hlData.positions?.length) {
          for (const p of hlData.positions) {
            const pnlSign = p.unrealizedPnl >= 0 ? "+" : "";
            lines.push(
              `  ${p.side.toUpperCase()} ${p.size} ${p.coin} @ $${p.entryPrice.toLocaleString()} → $${p.markPrice.toLocaleString()} (${pnlSign}$${p.unrealizedPnl.toFixed(2)})`
            );
          }
        } else {
          lines.push(`  No open positions.`);
        }
        if (hlData.openOrders?.length) {
          lines.push(`• Open orders: ${hlData.openOrders.length}`);
        }
      } else {
        lines.push(`**Hyperliquid**: Unable to fetch data.`);
      }

      lines.push("");

      // Polymarket section
      if (pmData) {
        lines.push(`**Polymarket**`);
        lines.push(`• Total invested: $${pmInvested.toLocaleString()}`);
        lines.push(
          `• Total returned: $${(pmData.totalReturned ?? 0).toLocaleString()}`
        );
        if (pmData.openPositions?.length) {
          for (const p of pmData.openPositions) {
            const pnlSign = p.unrealizedPnl >= 0 ? "+" : "";
            lines.push(
              `  ${p.side} $${p.size} "${p.marketQuestion}" (${pnlSign}$${p.unrealizedPnl.toFixed(2)})`
            );
          }
        } else {
          lines.push(`  No open positions.`);
        }
      } else {
        lines.push(`**Polymarket**: Unable to fetch data.`);
      }

      lines.push("");

      // Combined summary
      const totalValue = hlEquity + pmInvested + pmUnrealized;
      const netPnl = hlPnl + pmUnrealized;
      const pnlSign = netPnl >= 0 ? "+" : "";
      lines.push(`**Combined**`);
      lines.push(`• Total value: $${totalValue.toLocaleString()}`);
      lines.push(`• Net unrealized P&L: ${pnlSign}$${netPnl.toFixed(2)}`);

      const portfolio: CrossVenuePortfolio = {
        hyperliquid: hlData ?? {
          equity: 0,
          marginUsed: 0,
          effectiveLeverage: 0,
          positions: [],
          openOrders: [],
        },
        polymarket: pmData ?? {
          openPositions: [],
          resolvedBets: [],
          totalInvested: 0,
          totalReturned: 0,
        },
        combined: {
          totalValueUsd: totalValue,
          netPnlUsd: netPnl,
          hlEquity,
          pmInvested,
          pmUnrealized,
        },
      };

      await callback({
        text: lines.join("\n"),
        action: "CHECK_POSITIONS",
      });

      return { success: true, data: { portfolio } };
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Failed to fetch positions";
      await callback({
        text: `Error fetching positions: ${msg}`,
        action: "CHECK_POSITIONS",
      });
      return { success: false, error: msg };
    }
  },
};

export default checkPositions;
