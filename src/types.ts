import { z } from "zod";

// ─── Vincent Session ────────────────────────────────────────────────

export interface VincentSession {
  /** JWT from the Vincent Connect Page redirect */
  jwt: string;
  /** PKP Ethereum address — canonical user identity */
  pkpAddress: string;
  /** Approved Ability IPFS CIDs */
  approvedAbilityCids: string[];
  /** Policy parameter hashes from the JWT */
  policyHashes: Record<string, string>;
  /** JWT expiration as Unix timestamp (seconds) */
  expiresAt: number;
  /** When this session was established */
  createdAt: number;
}

// ─── Policy Schemas ─────────────────────────────────────────────────

export const HyperliquidTradingPolicySchema = z.object({
  maxPositionSizeUsd: z.number().positive(),
  maxDailyVolumeUsd: z.number().positive(),
  allowedCoins: z.array(z.string()).min(1),
  allowedOrderTypes: z.array(z.enum(["limit", "market", "stop"])),
  requireReduceOnly: z.boolean(),
  maxLeverage: z.number().positive(),
  cooldownSeconds: z.number().nonnegative(),
});

export type HyperliquidTradingPolicy = z.infer<
  typeof HyperliquidTradingPolicySchema
>;

export const PolymarketTradingPolicySchema = z.object({
  maxBetSizeUsd: z.number().positive(),
  maxDailyBetsUsd: z.number().positive(),
  allowedMarketTags: z.array(z.string()).min(1),
  minLiquidityUsd: z.number().nonnegative(),
  maxSlippageBps: z.number().nonnegative(),
  allowedOrderTypes: z.array(z.enum(["GTC", "GTD", "FOK"])),
});

export type PolymarketTradingPolicy = z.infer<
  typeof PolymarketTradingPolicySchema
>;

// ─── MCP Tool Parameters ────────────────────────────────────────────

export const HLTradeParamsSchema = z.object({
  coin: z.string().describe("Hyperliquid coin symbol, e.g. BTC, ETH, SOL"),
  side: z.enum(["long", "short"]).describe("Trade direction"),
  size: z.number().positive().describe("Position size in coin units"),
  orderType: z
    .enum(["market", "limit", "stop"])
    .describe("Order type"),
  price: z
    .number()
    .positive()
    .optional()
    .describe("Limit/stop price (required for limit and stop orders)"),
});

export type HLTradeParams = z.infer<typeof HLTradeParamsSchema>;

export const PMBetParamsSchema = z.object({
  marketQuery: z
    .string()
    .describe(
      "Natural language market description or Polymarket condition/token ID"
    ),
  side: z.enum(["YES", "NO"]).describe("Outcome side to bet on"),
  size: z.number().positive().describe("Bet size in USDC"),
  orderType: z
    .enum(["GTC", "GTD", "FOK"])
    .default("GTC")
    .describe("Order time-in-force type"),
});

export type PMBetParams = z.infer<typeof PMBetParamsSchema>;

// ─── MCP Tool Responses ─────────────────────────────────────────────

export interface HLTradeResponse {
  success: boolean;
  orderId?: string;
  status?: "accepted" | "filled" | "partially_filled" | "rejected";
  fillPrice?: number;
  filledSize?: number;
  remainingDailyBudgetUsd?: number;
  executionTimestamp?: number;
  policyWarnings?: PolicyWarning[];
  error?: string;
}

export interface PMBetResponse {
  success: boolean;
  orderId?: string;
  marketQuestion?: string;
  tokenId?: string;
  status?: "accepted" | "filled" | "rejected";
  fillPrice?: number;
  filledSize?: number;
  remainingDailyBudgetUsd?: number;
  executionTimestamp?: number;
  policyWarnings?: PolicyWarning[];
  error?: string;
}

export interface PolicyWarning {
  parameter: string;
  currentValue: number;
  threshold: number;
  message: string;
}

// ─── Position Data ──────────────────────────────────────────────────

export interface HLPosition {
  coin: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice?: number;
}

export interface HLAccountSummary {
  equity: number;
  marginUsed: number;
  effectiveLeverage: number;
  positions: HLPosition[];
  openOrders: HLOpenOrder[];
}

export interface HLOpenOrder {
  coin: string;
  side: "long" | "short";
  size: number;
  price: number;
  orderType: string;
  orderId: string;
}

export interface PMPosition {
  marketQuestion: string;
  conditionId: string;
  side: "YES" | "NO";
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  expiresAt?: string;
}

export interface PMResolvedBet {
  marketQuestion: string;
  side: "YES" | "NO";
  size: number;
  outcome: "won" | "lost";
  payout: number;
  resolvedAt: string;
}

export interface PMAccountSummary {
  openPositions: PMPosition[];
  resolvedBets: PMResolvedBet[];
  totalInvested: number;
  totalReturned: number;
}

export interface CrossVenuePortfolio {
  hyperliquid: HLAccountSummary;
  polymarket: PMAccountSummary;
  combined: {
    totalValueUsd: number;
    netPnlUsd: number;
    hlEquity: number;
    pmInvested: number;
    pmUnrealized: number;
  };
}

// ─── Provider Data ──────────────────────────────────────────────────

export interface HLMarketDataEntry {
  coin: string;
  midPrice: number;
  change24hPct: number;
  fundingRate: number;
}

export interface PMMarketEntry {
  conditionId: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  volumeUsd: number;
  liquidityUsd: number;
  tags: string[];
  endDate: string;
  isNew: boolean;
}

// ─── Risk Assessment ────────────────────────────────────────────────

export type RiskVerdict = "proceed" | "warn" | "block";

export interface RiskAssessment {
  verdict: RiskVerdict;
  reasons: string[];
  warnings: PolicyWarning[];
  requiresConfirmation: boolean;
}

// ─── MCP Connection Config ──────────────────────────────────────────

export interface VincentMCPConfig {
  transport: "stdio" | "http";
  serverBin?: string;
  serverUrl?: string;
  appId: string;
  appVersion?: string;
}

// ─── Constants ──────────────────────────────────────────────────────

export const PLUGIN_NAME = "plugin-vincent-finance";

export const MCP_TOOLS = {
  HL_TRADING: "hyperliquid-trading",
  PM_PREDICTION: "polymarket-prediction",
  PM_MONITOR: "polymarket-monitor",
} as const;

export const MCP_RESOURCES = {
  POLICY_CONFIG: "vincent://policy-config",
  SESSION_STATUS: "vincent://session-status",
} as const;

export const MCP_PROMPTS = {
  TRADING_INTENT: "trading-intent",
  MARKET_ANALYSIS: "market-analysis",
} as const;

export const DEFAULTS = {
  HL_PRICE_REFRESH_MS: 5_000,
  PM_MARKET_REFRESH_MS: 30_000,
  SESSION_TTL_SECONDS: 3_600,
  MCP_HEALTH_CHECK_INTERVAL_MS: 15_000,
  CIRCUIT_BREAKER_THRESHOLD: 3,
  CIRCUIT_BREAKER_RESET_MS: 60_000,
} as const;
