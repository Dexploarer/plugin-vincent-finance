import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { VincentMCPService } from "../services/VincentMCPService.js";
import { DEFAULTS, MCP_TOOLS } from "../types.js";
import type { PMMarketEntry } from "../types.js";

/**
 * Polymarket Market Scanner Provider
 *
 * Polls the Gamma API (via Vincent MCP server) for trending and newly
 * listed prediction markets. Surfaces opportunity context to the LLM
 * so it can proactively suggest bets that align with the user's interests.
 *
 * Provider position is set to 6 (after HL market data) so both venue
 * contexts are available when the agent composes its state.
 */

interface CachedScan {
  markets: PMMarketEntry[];
  fetchedAt: number;
}

let cache: CachedScan | null = null;

function isCacheValid(): boolean {
  return (
    cache !== null &&
    Date.now() - cache.fetchedAt < DEFAULTS.PM_MARKET_REFRESH_MS
  );
}

export const pmMarketScan: Provider = {
  name: "PM_MARKET_SCAN",
  description:
    "Scans Polymarket for trending and newly listed prediction markets, " +
    "providing context about high-volume markets and new opportunities.",
  position: 6,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<{ text: string; data: Record<string, unknown> }> => {
    const mcp = runtime.getService<VincentMCPService>("vincent-mcp");
    if (!mcp || !mcp.isConnected()) {
      return {
        text: "Polymarket scanner unavailable (MCP not connected).",
        data: { available: false },
      };
    }

    if (isCacheValid() && cache) {
      return formatScan(cache.markets);
    }

    try {
      const markets = await mcp.callTool<PMMarketEntry[]>(
        MCP_TOOLS.PM_MONITOR,
        { action: "scan_markets" }
      );

      cache = { markets, fetchedAt: Date.now() };
      return formatScan(markets);
    } catch {
      if (cache) {
        return formatScan(cache.markets, true);
      }
      return {
        text: "Polymarket scanner temporarily unavailable.",
        data: { available: false },
      };
    }
  },
};

function formatScan(
  markets: PMMarketEntry[],
  stale = false
): { text: string; data: Record<string, unknown> } {
  if (!markets.length) {
    return {
      text: "No Polymarket data available.",
      data: { available: false, markets: [] },
    };
  }

  // Separate new markets from trending by volume
  const newMarkets = markets.filter((m) => m.isNew);
  const trending = [...markets]
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, 8);

  const lines: string[] = [
    stale ? "**Polymarket Scanner** (stale data)" : "**Polymarket Scanner**",
  ];

  if (newMarkets.length) {
    lines.push(`\n_New Markets (${newMarkets.length}):_`);
    for (const m of newMarkets.slice(0, 5)) {
      lines.push(
        `• "${m.question}" — YES $${m.yesPrice.toFixed(2)} / NO $${m.noPrice.toFixed(2)} (liq: $${formatCompact(m.liquidityUsd)})`
      );
    }
  }

  lines.push(`\n_Trending by Volume:_`);
  for (const m of trending) {
    lines.push(
      `• "${m.question}" — YES $${m.yesPrice.toFixed(2)} / NO $${m.noPrice.toFixed(2)} (vol: $${formatCompact(m.volumeUsd)}, liq: $${formatCompact(m.liquidityUsd)})`
    );
  }

  return {
    text: lines.join("\n"),
    data: {
      available: true,
      stale,
      newMarkets,
      trending,
      allMarkets: markets,
      fetchedAt: cache?.fetchedAt ?? Date.now(),
    },
  };
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

export default pmMarketScan;
