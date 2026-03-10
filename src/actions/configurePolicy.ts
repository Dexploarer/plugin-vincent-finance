import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  ActionExample,
} from "@elizaos/core";
import { VincentMCPService } from "../services/VincentMCPService.js";
import { PLUGIN_NAME } from "../types.js";

const VINCENT_CONNECT_BASE = "https://connect.vincent.lit.dev";

const examples: ActionExample[] = [
  [
    {
      name: "{{user1}}",
      content: { text: "I want to update my trading limits" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Here's a link to update your Vincent policy parameters. This will open the Vincent consent page where you can adjust your trading limits.",
        action: "CONFIGURE_POLICY",
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: { text: "Connect my wallet to Vincent" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Opening the Vincent Connect page. Approve the requested abilities to grant this agent delegated trading access.",
        action: "CONFIGURE_POLICY",
      },
    },
  ],
];

export const configurePolicy: Action = {
  name: "CONFIGURE_POLICY",
  description:
    "Generate a Vincent Connect Page URL for the user to approve or update " +
    "their delegated trading policy parameters. Handles both initial consent " +
    "and policy reconfiguration flows.",
  similes: [
    "CONFIGURE",
    "POLICY",
    "CONNECT",
    "CONSENT",
    "APPROVE",
    "WALLET",
    "LIMITS",
    "PERMISSIONS",
    "AUTHORIZE",
    "SETTINGS",
    "UPDATE_POLICY",
  ],
  examples,

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State
  ): Promise<boolean> => {
    const text = (message.content?.text ?? "").toLowerCase();
    const keywords = [
      "connect",
      "policy",
      "configure",
      "consent",
      "approve",
      "limit",
      "permission",
      "authorize",
      "wallet",
      "setting",
      "update policy",
      "change limit",
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
    const appId = runtime.getSetting("VINCENT_APP_ID");
    if (!appId) {
      await callback({
        text: "VINCENT_APP_ID is not configured. Cannot generate Connect URL.",
        action: "CONFIGURE_POLICY",
      });
      return { success: false, error: "Missing VINCENT_APP_ID" };
    }

    const mcp = runtime.getService<VincentMCPService>("vincent-mcp");
    const hasExistingSession = mcp?.isSessionValid() ?? false;

    // ── Build Connect Page URL ─────────────────────────────────────
    const params = new URLSearchParams({
      app_id: appId,
      redirect_uri: `${runtime.getSetting("VINCENT_CALLBACK_URL") ?? "/auth/vincent/callback"}`,
    });

    // If user asked about specific limits, try to extract and pre-fill
    const text = (message.content?.text ?? "").toLowerCase();
    if (text.includes("hyperliquid") || text.includes("trading")) {
      params.set("ability_scope", "hyperliquid-trading");
    }
    if (text.includes("polymarket") || text.includes("prediction")) {
      params.set("ability_scope", "polymarket-trading");
    }

    const connectUrl = `${VINCENT_CONNECT_BASE}?${params.toString()}`;

    // ── Respond with context-appropriate message ───────────────────
    if (hasExistingSession) {
      await callback({
        text:
          `You already have an active Vincent session. To update your policy parameters, ` +
          `visit the Vincent Connect page:\n\n${connectUrl}\n\n` +
          `After approval, your new limits will take effect on the next trade.`,
        action: "CONFIGURE_POLICY",
      });
    } else {
      await callback({
        text:
          `To authorize delegated trading, connect your wallet through Vincent:\n\n` +
          `${connectUrl}\n\n` +
          `You'll be able to set:\n` +
          `• Maximum position sizes and daily volume limits\n` +
          `• Allowed coins and order types\n` +
          `• Leverage caps and cooldown periods\n\n` +
          `Your private keys never leave the Lit Network. Vincent only signs ` +
          `transactions that comply with the policy you approve.`,
        action: "CONFIGURE_POLICY",
      });
    }

    return {
      success: true,
      data: {
        connectUrl,
        isReconfiguration: hasExistingSession,
      },
    };
  },
};

export default configurePolicy;
