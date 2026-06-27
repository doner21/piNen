/**
 * GoDaddy MCP Extension for Pi Code
 *
 * Connects to GoDaddy's remote MCP server at api.godaddy.com for domain
 * search and availability checking. Uses streamable HTTP transport (no
 * local process — the server runs on GoDaddy's infrastructure).
 *
 * Unlike the Playwright or Railway MCP servers, GoDaddy's MCP server:
 *   - Uses Streamable HTTP transport (not stdio)
 *   - Requires NO authentication (public data only)
 *   - Is read-only (search domains, check availability)
 *
 * Configuration (for reference):
 *   {
 *     "mcpServers": {
 *       "godaddy": {
 *         "url": "https://api.godaddy.com/v1/domains/mcp",
 *         "transport": "streamable-http"
 *       }
 *     }
 *   }
 *
 * Tools provided:
 *   - Domain search (find available domains by keywords)
 *   - Availability check (verify if specific domains are available)
 *
 * Prerequisites: None (public API, no auth needed)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerMcpServer, unregisterMcpServer } from "./mcp-status.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const GODADDY_MCP_URL = "https://api.godaddy.com/v1/domains/mcp";

// ─── Module-level state ───────────────────────────────────────────────────────

let mcpClient: Client | null = null;
let mcpTransport: StreamableHTTPClientTransport | null = null;

// ─── Bridge Initialization ────────────────────────────────────────────────────

async function startMcpBridge(pi: ExtensionAPI): Promise<void> {
  // Create streamable HTTP transport — connects to GoDaddy's hosted MCP endpoint
  mcpTransport = new StreamableHTTPClientTransport(new URL(GODADDY_MCP_URL));

  // Create and connect the MCP client
  mcpClient = new Client({
    name: "pi-godaddy-bridge",
    version: "1.0.0",
  });

  await mcpClient.connect(mcpTransport);

  // Discover all available tools (handle pagination)
  const allTools: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const response = await mcpClient.listTools(cursor ? { cursor } : undefined);
    allTools.push(...response.tools);
    cursor = response.nextCursor;
  } while (cursor);

  // Register every discovered tool with Pi
  for (const tool of allTools) {
    const toolName = tool.name as string;
    const toolDescription = (tool.description as string) ?? toolName;
    const toolSchema = tool.inputSchema ?? { type: "object", properties: {} };

    pi.registerTool({
      name: toolName,
      label: toolName,
      description: toolDescription,
      parameters: Type.Unsafe<Record<string, unknown>>(toolSchema),

      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: any,
        _ctx: any,
      ) => {
        if (!mcpClient) {
          return {
            content: [
              {
                type: "text" as const,
                text: `[godaddy-mcp] Error: MCP client is not connected.`,
              },
            ],
          };
        }

        try {
          const result = await mcpClient.callTool({
            name: toolName,
            arguments: params as Record<string, unknown>,
          });

          // Process content items from the MCP result
          const contentItems: Array<{ type: "text"; text: string }> = [];

          for (const item of (result.content ?? []) as any[]) {
            if (item.type === "text") {
              contentItems.push({
                type: "text" as const,
                text: item.text as string,
              });
            } else if (item.type === "image") {
              const mimeType = (item.mimeType as string) ?? "image/png";
              const data = item.data as string;
              contentItems.push({
                type: "text" as const,
                text: `[godaddy-mcp image]\ndata:${mimeType};base64,${data}`,
              });
            } else {
              contentItems.push({
                type: "text" as const,
                text: JSON.stringify(item),
              });
            }
          }

          if (contentItems.length === 0) {
            contentItems.push({
              type: "text" as const,
              text: `[godaddy-mcp] Tool "${toolName}" completed.`,
            });
          }

          return { content: contentItems };
        } catch (err: unknown) {
          return {
            content: [
              {
                type: "text" as const,
                text: `[godaddy-mcp] Tool "${toolName}" failed: ${(err as any)?.message ?? String(err)}`,
              },
            ],
          };
        }
      },
    });
  }

  console.log(`[godaddy-mcp] Registered ${allTools.length} GoDaddy domain tools.`);

  // ── Register with the shared MCP status registry ──────────────────────────
  registerMcpServer({
    id: "godaddy-mcp",
    label: "GoDaddy MCP",
    status: "connected",
    tools: allTools.map((t) => t.name as string),
  });
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function godaddyMcpExtension(pi: ExtensionAPI) {
  // ─── Session Start: connect to GoDaddy MCP and register tools ────────────

  pi.on("session_start", async (_event: any, _ctx: any) => {
    if (mcpClient) return; // already connected — guard against double-init

    try {
      await startMcpBridge(pi);
    } catch (err: any) {
      console.warn(
        "[godaddy-mcp] Failed to connect to GoDaddy MCP server:",
        err?.message ?? String(err),
      );
      registerMcpServer({
        id: "godaddy-mcp",
        label: "GoDaddy MCP",
        status: "error",
        error: err?.message ?? String(err),
        tools: [],
      });
      mcpClient = null;
      mcpTransport = null;
    }
  });

  // ─── Session Shutdown: close MCP connection cleanly ──────────────────────

  pi.on("session_shutdown", async (_event?: any) => {
    if (mcpTransport) {
      await mcpTransport.close().catch((err: any) => {
        console.warn(
          "[godaddy-mcp] Error during MCP transport close:",
          err?.message ?? String(err),
        );
      });
      unregisterMcpServer("godaddy-mcp");
      mcpClient = null;
      mcpTransport = null;
    }
  });
}
