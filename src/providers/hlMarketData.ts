import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { VincentMCPService } from "../services/VincentMCPService.js";
import { DEFAULTS } from "../types.js";
import type { HLMarketDataEntry } from "../types.js";

/**
 * Hyperliquid Market Data Provider
 *
 * Injects real-time perpetual futures pricing context into the agent's
 * state so the LLM can make informed trading decisions. Polls allMids
 * and funding rates from the Hyperliquid API via the Vincent MCP server.
 *
 * Provider position is set low (5) so price context is available before
 * trading actions are evaluated.
 */

interface CachedMarketData {
  entries: HLMarketDataEntry[];
  fetchedAt: number;
}

let cache: CachedMarketData | null = null;

function isCacheValid(): boolean {
  return (
    cache !== null &&
    Date.now() - cache.fetchedAt < DEFAULTS.HL_PRICE_REFRESH_MS
  );
}

export const hlMarketData: Provider = {
  name: "HL_MARKET_DATA",
  description:
    "Provides real-time Hyperliquid perpetual futures market data including " +
    "mid prices, 24h changes, and funding rates for context-aware trading.",
  position: 5,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<{ text: string; data: Record<string, unknown> }> => {
    const mcp = runtime.getService<VincentMCPService>("vincent-mcp");
    if (!mcp || !mcp.isConnected()) {
      return {
        text: "Hyperliquid market data unavailable (MCP not connected).",
        data: { available: false },
      };
    }

    // Return cached data if still fresh
    if (isCacheValid() && cache) {
      return formatMarketData(cache.entries);
    }

    try {
      const entries = await mcp.callTool<HLMarketDataEntry[]>(
        "hyperliquid-market-data",
        { action: "allMids" }
      );

      cache = { entries, fetchedAt: Date.now() };
      return formatMarketData(entries);
    } catch {
      // Return stale cache if available, otherwise empty
      if (cache) {
        return formatMarketData(cache.entries, true);
      }
      return {
        text: "Hyperliquid market data temporarily unavailable.",
        data: { available: false },
      };
    }
  },
};

function formatMarketData(
  entries: HLMarketDataEntry[],
  stale = false
): { text: string; data: Record<string, unknown> } {
  if (!entries.length) {
    return {
      text: "No Hyperliquid market data available.",
      data: { available: false, entries: [] },
    };
  }

  // Top movers by absolute 24h change
  const sorted = [...entries].sort(
    (a, b) => Math.abs(b.change24hPct) - Math.abs(a.change24hPct)
  );
  const top = sorted.slice(0, 10);

  const lines = [
    stale ? "**Hyperliquid Markets** (stale data)" : "**Hyperliquid Markets**",
    ...top.map((e) => {
      const sign = e.change24hPct >= 0 ? "+" : "";
      const fundingBps = (e.fundingRate * 10000).toFixed(2);
      return `${e.coin}: $${e.midPrice.toLocaleString()} (${sign}${e.change24hPct.toFixed(2)}%, funding: ${fundingBps}bps)`;
    }),
  ];

  return {
    text: lines.join("\n"),
    data: {
      available: true,
      stale,
      topMovers: top,
      allEntries: entries,
      fetchedAt: cache?.fetchedAt ?? Date.now(),
    },
  };
}

export default hlMarketData;
