import type { IAgentRuntime } from "@elizaos/core";
import { Service } from "@elizaos/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type {
  VincentMCPConfig,
  VincentSession,
  RiskAssessment,
} from "../types.js";
import { PLUGIN_NAME, DEFAULTS } from "../types.js";

// ─── Circuit Breaker ─────────────────────────────────────────────────

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreaker {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: number;
  threshold: number;
  resetMs: number;
}

function createCircuitBreaker(): CircuitBreaker {
  return {
    state: "closed",
    failureCount: 0,
    lastFailureAt: 0,
    threshold: DEFAULTS.CIRCUIT_BREAKER_THRESHOLD,
    resetMs: DEFAULTS.CIRCUIT_BREAKER_RESET_MS,
  };
}

function recordFailure(cb: CircuitBreaker): void {
  cb.failureCount += 1;
  cb.lastFailureAt = Date.now();
  if (cb.failureCount >= cb.threshold) {
    cb.state = "open";
  }
}

function recordSuccess(cb: CircuitBreaker): void {
  cb.failureCount = 0;
  cb.state = "closed";
}

function canAttempt(cb: CircuitBreaker): boolean {
  if (cb.state === "closed") return true;
  if (cb.state === "open") {
    if (Date.now() - cb.lastFailureAt >= cb.resetMs) {
      cb.state = "half-open";
      return true;
    }
    return false;
  }
  // half-open: allow one attempt
  return true;
}

// ─── Service Implementation ──────────────────────────────────────────

export class VincentMCPService extends Service {
  static serviceType = "vincent-mcp";
  capabilityDescription =
    "Manages MCP connection to Vincent server for delegated trading operations";

  private client: Client | null = null;
  private transport: StdioClientTransport | SSEClientTransport | null = null;
  private config: VincentMCPConfig | null = null;
  private runtime: IAgentRuntime | null = null;
  private circuitBreaker: CircuitBreaker = createCircuitBreaker();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private session: VincentSession | null = null;
  private connected = false;

  // ── Lifecycle ────────────────────────────────────────────────────

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const instance = new VincentMCPService();
    await instance.initialize(runtime);
    return instance;
  }

  private async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    this.config = {
      transport:
        (runtime.getSetting("VINCENT_MCP_TRANSPORT") as "stdio" | "http") ??
        "stdio",
      serverBin:
        runtime.getSetting("VINCENT_MCP_SERVER_BIN") ??
        "npx @lit-protocol/vincent-mcp-server",
      serverUrl: runtime.getSetting("VINCENT_MCP_SERVER_URL") ?? undefined,
      appId: runtime.getSetting("VINCENT_APP_ID") ?? "",
    };

    if (!this.config.appId) {
      throw new Error(
        `[${PLUGIN_NAME}] VINCENT_APP_ID is required but not set`
      );
    }

    await this.connect();
    this.startHealthCheck();
  }

  async stop(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    await this.disconnect();
  }

  // ── Connection Management ────────────────────────────────────────

  private async connect(): Promise<void> {
    if (!this.config) throw new Error("Service not initialized");

    this.client = new Client(
      { name: PLUGIN_NAME, version: "0.1.0" },
      { capabilities: { tools: {}, resources: {} } }
    );

    if (this.config.transport === "stdio") {
      const [command, ...args] = (this.config.serverBin ?? "").split(" ");
      this.transport = new StdioClientTransport({
        command,
        args,
        env: {
          ...process.env,
          VINCENT_APP_ID: this.config.appId,
        },
      });
    } else {
      if (!this.config.serverUrl) {
        throw new Error(
          `[${PLUGIN_NAME}] VINCENT_MCP_SERVER_URL required for HTTP transport`
        );
      }
      this.transport = new SSEClientTransport(
        new URL(this.config.serverUrl)
      );
    }

    await this.client.connect(this.transport);
    this.connected = true;

    this.runtime?.emitEvent("ACTION_STARTED" as any, {
      source: PLUGIN_NAME,
      action: "mcp_connected",
      transport: this.config.transport,
    });
  }

  private async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
      this.transport = null;
      this.connected = false;
    }
  }

  private async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  // ── Health Monitoring ────────────────────────────────────────────

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.readResource("vincent://session-status");
        recordSuccess(this.circuitBreaker);
      } catch {
        recordFailure(this.circuitBreaker);
        if (this.circuitBreaker.state === "open") {
          this.runtime?.emitEvent("ACTION_COMPLETED" as any, {
            source: PLUGIN_NAME,
            action: "circuit_breaker_open",
            failureCount: this.circuitBreaker.failureCount,
          });
        }
      }
    }, DEFAULTS.MCP_HEALTH_CHECK_INTERVAL_MS);
  }

  // ── Public API ───────────────────────────────────────────────────

  async callTool<T = unknown>(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<T> {
    if (!canAttempt(this.circuitBreaker)) {
      throw new Error(
        `[${PLUGIN_NAME}] Circuit breaker OPEN — MCP server unreachable. ` +
          `Retry after ${Math.ceil(this.circuitBreaker.resetMs / 1000)}s.`
      );
    }

    if (!this.client || !this.connected) {
      await this.reconnect();
    }

    try {
      const result = await this.client!.callTool({
        name: toolName,
        arguments: params,
      });

      recordSuccess(this.circuitBreaker);

      // MCP tool results come as content array; parse first text block
      const textContent = (result.content as any[])?.find(
        (c: any) => c.type === "text"
      );
      if (textContent?.text) {
        return JSON.parse(textContent.text) as T;
      }
      return result as unknown as T;
    } catch (error) {
      recordFailure(this.circuitBreaker);
      throw error;
    }
  }

  async readResource(uri: string): Promise<unknown> {
    if (!this.client || !this.connected) {
      await this.reconnect();
    }

    const result = await this.client!.readResource({ uri });
    const textContent = (result.contents as any[])?.find(
      (c: any) => c.mimeType === "application/json" || c.text
    );
    if (textContent?.text) {
      return JSON.parse(textContent.text);
    }
    return result;
  }

  async listTools(): Promise<string[]> {
    if (!this.client || !this.connected) {
      await this.reconnect();
    }
    const result = await this.client!.listTools();
    return result.tools.map((t) => t.name);
  }

  // ── Session Management ───────────────────────────────────────────

  getSession(): VincentSession | null {
    if (this.session && this.session.expiresAt < Date.now() / 1000) {
      this.session = null;
    }
    return this.session;
  }

  setSession(session: VincentSession): void {
    this.session = session;
  }

  isSessionValid(): boolean {
    const s = this.getSession();
    return s !== null && s.expiresAt > Date.now() / 1000;
  }

  // ── Status Accessors ─────────────────────────────────────────────

  isConnected(): boolean {
    return this.connected;
  }

  getCircuitBreakerState(): CircuitState {
    return this.circuitBreaker.state;
  }

  getConfig(): VincentMCPConfig | null {
    return this.config;
  }
}

export default VincentMCPService;
