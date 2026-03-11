import type { Plugin } from "@elizaos/core";
import { VincentMCPService } from "./services/VincentMCPService.js";
import { tradeHyperliquid } from "./actions/tradeHyperliquid.js";
import { betPolymarket } from "./actions/betPolymarket.js";
import { checkPositions } from "./actions/checkPositions.js";
import { configurePolicy } from "./actions/configurePolicy.js";
import { hlMarketData } from "./providers/hlMarketData.js";
import { pmMarketScan } from "./providers/pmMarketScan.js";
import { riskAssessor } from "./evaluators/riskAssessor.js";
import { PLUGIN_NAME } from "./types.js";

export const vincentFinancePlugin: Plugin = {
  name: PLUGIN_NAME,
  description:
    "Vincent-powered delegated trading across Hyperliquid perpetual futures " +
    "and Polymarket prediction markets. Uses MCP protocol for secure " +
    "communication with Vincent's Lit Network PKP signing infrastructure.",

  services: [VincentMCPService],

  actions: [tradeHyperliquid, betPolymarket, checkPositions, configurePolicy],

  providers: [hlMarketData, pmMarketScan],

  evaluators: [riskAssessor],

  init: async (config, runtime) => {
    const appId = config.VINCENT_APP_ID ?? runtime.getSetting("VINCENT_APP_ID");
    if (!appId) {
      throw new Error(
        `[${PLUGIN_NAME}] VINCENT_APP_ID is required. ` +
          `Set it in your agent's plugin configuration or environment.`
      );
    }
  },
};

// ── Re-exports for consumer convenience ────────────────────────────

export { VincentMCPService } from "./services/VincentMCPService.js";
export { tradeHyperliquid } from "./actions/tradeHyperliquid.js";
export { betPolymarket } from "./actions/betPolymarket.js";
export { checkPositions } from "./actions/checkPositions.js";
export { configurePolicy } from "./actions/configurePolicy.js";
export { hlMarketData } from "./providers/hlMarketData.js";
export { pmMarketScan } from "./providers/pmMarketScan.js";
export { riskAssessor } from "./evaluators/riskAssessor.js";

export * from "./types.js";

export default vincentFinancePlugin;
