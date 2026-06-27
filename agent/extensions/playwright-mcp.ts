/**
 * Playwright MCP Extension for Pi Code
 *
 * Lazily spawns the Playwright MCP server on first browser tool use and
 * registers its browser automation tools into Pi's tool registry via
 * pi.registerTool() during session start without launching a child process.
 *
 * The MCP server communicates over stdio (JSON-RPC 2.0). This extension
 * uses @modelcontextprotocol/sdk to connect to it as an MCP client.
 *
 * Required tools registered (at minimum):
 *   browser_navigate, browser_click, browser_snapshot,
 *   browser_take_screenshot, browser_type
 *
 * All other tools returned by Playwright MCP's default tool schema are also
 * registered.
 *
 * Screenshot results are returned as base64 data URIs in text content,
 * which is safe across all LLM providers.
 *
 * Auto-recovery: if a zombie Chrome process holds the browser profile lock,
 * this extension kills it via PowerShell Stop-Process (not taskkill — taskkill
 * is broken in bash on Windows due to /F → F:/ path mangling) and retries.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { env } from "node:process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { registerMcpServer, unregisterMcpServer } from "./mcp-status.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const PLAYWRIGHT_MCP_CLI_PATH = join(
  env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@playwright",
  "mcp",
  "cli.js"
);

const nodeRequire = createRequire(import.meta.url);

// ─── Lock recovery helpers ────────────────────────────────────────────────────

const MCP_PROFILES_DIR = join(
  env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"),
  "ms-playwright"
);

/** Kill all Chrome processes using PowerShell Stop-Process.
 *  Uses spawnSync with shell:false so no cmd.exe/conhost.exe console window
 *  is allocated (the source of the terminal flash). windowsHide:true adds
 *  CREATE_NO_WINDOW as a belt-and-braces guard. */
function killZombieChrome(): void {
  try {
    spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue"],
      { stdio: "ignore", windowsHide: true, shell: false }
    );
    console.log("[playwright-mcp] Killed zombie Chrome processes.");
  } catch {
    // Ignore — means no chrome processes were running
  }
}

/** Return true if any mcp-chrome-* profile has a Default/LOCK file present. */
function isBrowserLockPresent(): boolean {
  if (!existsSync(MCP_PROFILES_DIR)) return false;
  try {
    return readdirSync(MCP_PROFILES_DIR)
      .filter((d) => d.startsWith("mcp-chrome-"))
      .some((d) => existsSync(join(MCP_PROFILES_DIR, d, "Default", "LOCK")));
  } catch {
    return false;
  }
}

/** Remove stale Default/LOCK files from all mcp-chrome-* profile dirs.
 *  Only safe to call after Chrome has been killed. */
function clearStaleLocks(): void {
  if (!existsSync(MCP_PROFILES_DIR)) return;
  try {
    for (const dir of readdirSync(MCP_PROFILES_DIR).filter((d) =>
      d.startsWith("mcp-chrome-")
    )) {
      const lockPath = join(MCP_PROFILES_DIR, dir, "Default", "LOCK");
      if (existsSync(lockPath)) {
        try {
          rmSync(lockPath);
          console.log(`[playwright-mcp] Removed stale lock: ${lockPath}`);
        } catch {
          // File still held — Chrome kill may need a moment; proceed anyway
        }
      }
    }
  } catch {
    // Non-fatal
  }
}

/** Kill zombie Chrome and remove stale locks. Returns after a short settle. */
async function recoverBrowserLock(): Promise<void> {
  killZombieChrome();
  // Give the OS a moment to release file handles before removing lock files.
  await new Promise<void>((resolve) => setTimeout(resolve, 800));
  clearStaleLocks();
}

const LOCK_ERROR_PATTERNS = [
  "already in use",
  "browser is already",
  "LOCK",
  "user data dir",
];

function isLockError(err: unknown): boolean {
  const msg = (err as any)?.message ?? String(err);
  return LOCK_ERROR_PATTERNS.some((p) => msg.toLowerCase().includes(p.toLowerCase()));
}

// ─── Module-level state ───────────────────────────────────────────────────────

type McpToolSchema = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;
let connectPromise: Promise<void> | null = null;
let toolRegistrationPromise: Promise<void> | null = null;
let toolsRegistered = false;
let registeredToolNames: string[] = [];
let cachedToolSchemas: McpToolSchema[] | null = null;

// ─── Playwright MCP schema resolution ─────────────────────────────────────────

function resolvePlaywrightMcpCliPath(): string {
  if (!existsSync(PLAYWRIGHT_MCP_CLI_PATH)) {
    throw new Error(
      `[playwright-mcp] Missing Playwright MCP CLI at ${PLAYWRIGHT_MCP_CLI_PATH}. ` +
      "Install it with: npm install -g @playwright/mcp"
    );
  }
  return PLAYWRIGHT_MCP_CLI_PATH;
}

function resolvePlaywrightMcpPackageFile(relativePath: string): string {
  const packageRoot = dirname(resolvePlaywrightMcpCliPath());
  const resolvedPath = join(packageRoot, relativePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`[playwright-mcp] Missing Playwright MCP package file: ${resolvedPath}`);
  }
  return resolvedPath;
}

async function discoverPlaywrightToolSchemas(): Promise<McpToolSchema[]> {
  if (cachedToolSchemas) return cachedToolSchemas;

  const exportsPath = resolvePlaywrightMcpPackageFile(
    join("node_modules", "playwright-core", "lib", "tools", "exports.js")
  );
  const configPath = resolvePlaywrightMcpPackageFile(
    join("node_modules", "playwright-core", "lib", "tools", "mcp", "config.js")
  );

  const { filteredTools, toMcpTool } = nodeRequire(exportsPath) as {
    filteredTools: (config: any) => any[];
    toMcpTool: (toolSchema: any) => McpToolSchema;
  };
  const { resolveCLIConfigForMCP } = nodeRequire(configPath) as {
    resolveCLIConfigForMCP: (cliOptions: Record<string, unknown>, env: NodeJS.ProcessEnv) => Promise<any>;
  };

  // Mirrors `node <@playwright/mcp/cli.js> --headless` schema selection without
  // spawning the MCP server. Environment/config-file overrides are still honored.
  const config = await resolveCLIConfigForMCP({ headless: true }, env);
  cachedToolSchemas = filteredTools(config).map((tool) => toMcpTool(tool.schema));
  return cachedToolSchemas;
}

// ─── Connection lifecycle ─────────────────────────────────────────────────────

async function closeMcpConnection(unregister = false): Promise<void> {
  const client = mcpClient;
  const transport = mcpTransport;
  mcpClient = null;
  mcpTransport = null;

  if (client) {
    await client.close().catch((err: any) => {
      console.warn("[playwright-mcp] Error during MCP client close:", err?.message ?? String(err));
    });
  }
  if (transport) {
    await transport.close().catch((err: any) => {
      console.warn("[playwright-mcp] Error during MCP transport close:", err?.message ?? String(err));
    });
  }
  if (unregister) unregisterMcpServer("playwright-mcp");
}

// ─── Bridge Initialization ────────────────────────────────────────────────────

async function startMcpBridge(_pi: ExtensionAPI): Promise<void> {
  if (mcpClient) return;

  const resolvedCliPath = resolvePlaywrightMcpCliPath();

  // Pre-flight: if a stale lock is already present, recover before connecting.
  if (isBrowserLockPresent()) {
    console.log("[playwright-mcp] Stale browser lock detected — recovering before connect…");
    await recoverBrowserLock();
  }

  // Attempt to connect — retry once on lock errors.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // Create transport — spawn Node directly to bypass Windows .cmd shims.
      // Keep this on node + cli.js so Windows bypasses .cmd/cmd.exe/conhost; the SDK sets windowsHide on win32.
      mcpTransport = new StdioClientTransport({
        command: "node",
        args: [resolvedCliPath, "--headless"],
        stderr: "pipe",
      });

      // Create and connect the MCP client
      mcpClient = new Client({ name: "pi-playwright-bridge", version: "1.0.0" });
      await mcpClient.connect(mcpTransport);
      break; // success — exit retry loop
    } catch (err: unknown) {
      lastError = err;
      await closeMcpConnection();
      if (attempt === 1 && isLockError(err)) {
        console.log("[playwright-mcp] Connect failed with lock error — killing Chrome and retrying…");
        await recoverBrowserLock();
        continue;
      }
      throw err; // non-lock error or second attempt — propagate
    }
  }
  if (!mcpClient) throw lastError;

  registerMcpServer({
    id: "playwright-mcp",
    label: "Playwright MCP",
    status: "connected",
    tools: registeredToolNames,
  });

  console.log("[playwright-mcp] Connected to Playwright MCP server.");
}

async function ensureConnected(pi: ExtensionAPI): Promise<void> {
  if (mcpClient) return;
  if (!connectPromise) {
    connectPromise = startMcpBridge(pi)
      .catch((err: unknown) => {
        registerMcpServer({
          id: "playwright-mcp",
          label: "Playwright MCP",
          status: "error",
          error: (err as any)?.message ?? String(err),
          tools: registeredToolNames,
        });
        throw err;
      })
      .finally(() => {
        connectPromise = null;
      });
  }
  await connectPromise;
}

// ─── Tool registration ────────────────────────────────────────────────────────

function formatMcpResult(toolName: string, result: any): { content: Array<{ type: "text"; text: string }> } {
  const contentItems: Array<{ type: "text"; text: string }> = [];

  for (const item of (result.content ?? []) as any[]) {
    if (item.type === "text") {
      // Plain text — pass through directly
      contentItems.push({ type: "text" as const, text: item.text as string });
    } else if (item.type === "image") {
      // Image content (e.g. screenshots) — encode as data URI in text
      // This is safe across all LLM providers regardless of image support
      const mimeType = (item.mimeType as string) ?? "image/png";
      const data = item.data as string;
      contentItems.push({
        type: "text" as const,
        text: `[screenshot]\ndata:${mimeType};base64,${data}`,
      });
    } else {
      // Unknown content type — stringify as fallback
      contentItems.push({
        type: "text" as const,
        text: JSON.stringify(item),
      });
    }
  }

  if (contentItems.length === 0) {
    contentItems.push({ type: "text" as const, text: `[playwright-mcp] Tool "${toolName}" completed with no output.` });
  }

  return { content: contentItems };
}

async function registerPlaywrightTools(pi: ExtensionAPI): Promise<void> {
  if (toolsRegistered) return;
  if (!toolRegistrationPromise) {
    toolRegistrationPromise = (async () => {
      const allTools = await discoverPlaywrightToolSchemas();
      registeredToolNames = allTools.map((tool) => tool.name as string);

      // Register every discovered tool with Pi. Each execute handler lazily
      // connects to the MCP server on first use.
      for (const tool of allTools) {
        const toolName = tool.name as string;
        const toolDescription = (tool.description as string) ?? toolName;
        const toolSchema = tool.inputSchema ?? { type: "object", properties: {} };

        pi.registerTool({
          name: toolName,
          label: toolName,
          description: toolDescription,
          parameters: Type.Unsafe<Record<string, unknown>>(toolSchema),

          execute: async (_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: any, _ctx: any) => {
            let result: any;
            try {
              await ensureConnected(pi);
              if (!mcpClient) {
                return {
                  content: [{ type: "text" as const, text: `[playwright-mcp] Error: MCP client is not connected.` }],
                };
              }
              result = await mcpClient.callTool({ name: toolName, arguments: params as Record<string, unknown> });
            } catch (err: unknown) {
              // If the tool fails with a lock error mid-session (e.g. Chrome crashed
              // after Pi started), kill the zombie, restart the bridge, and retry once.
              if (isLockError(err)) {
                console.log(`[playwright-mcp] Tool "${toolName}" hit lock error — recovering and retrying…`);
                await closeMcpConnection();
                await recoverBrowserLock();
                try {
                  await ensureConnected(pi);
                  result = await mcpClient!.callTool({ name: toolName, arguments: params as Record<string, unknown> });
                } catch (retryErr: unknown) {
                  return {
                    content: [{ type: "text" as const, text: `[playwright-mcp] Recovery failed for "${toolName}": ${(retryErr as any)?.message ?? String(retryErr)}` }],
                  };
                }
              } else {
                return {
                  content: [{ type: "text" as const, text: `[playwright-mcp] Tool call failed: ${(err as any)?.message ?? String(err)}` }],
                };
              }
            }

            return formatMcpResult(toolName, result);
          },
        });
      }

      toolsRegistered = true;
      console.log(`[playwright-mcp] Registered ${allTools.length} browser tools (lazy MCP spawn).`);
    })().catch((err: unknown) => {
      toolRegistrationPromise = null;
      throw err;
    });
  }

  await toolRegistrationPromise;
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function playwrightMcpExtension(pi: ExtensionAPI) {

  // ─── Session Start: register tools only; defer MCP spawn to first tool use ─

  pi.on("session_start", async (_event: any, _ctx: any) => {
    try {
      await registerPlaywrightTools(pi);
    } catch (err: any) {
      console.warn(
        "[playwright-mcp] Failed to register Playwright MCP tools:",
        err?.message ?? String(err),
        "\nEnsure @playwright/mcp is installed: npm install -g @playwright/mcp"
      );
      registerMcpServer({
        id: "playwright-mcp",
        label: "Playwright MCP",
        status: "error",
        error: err?.message ?? String(err),
        tools: [],
      });
    }
  });

  // ─── Session Shutdown: close MCP connection cleanly ──────────────────────

  pi.on("session_shutdown", async (_event?: any) => {
    const pendingConnect = connectPromise;
    connectPromise = null;
    if (pendingConnect) await pendingConnect.catch(() => {});
    await closeMcpConnection(true);
    // NOTE: killZombieChrome() is intentionally NOT called on session_shutdown.
    // It spawns a PowerShell process which (even with windowsHide) can allocate
    // a visible conhost on some Windows setups, causing terminal flashes on
    // every reload. Chrome cleanup only runs during browser-lock recovery on
    // connect (recoverBrowserLock), where it is actually needed.
  });
}
