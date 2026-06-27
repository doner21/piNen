/**
 * MCP Status Extension for Pi Code
 *
 * Provides a /mcp slash command to inspect all active MCP servers,
 * their connection status, and the tools they have registered with Pi.
 *
 * Active server registrations are written to a shared runtime state file:
 *   ~/.pi/agent/mcp-registry.json
 *
 * Each MCP-bridging extension (e.g. playwright-mcp.ts) should call
 * the exported `registerMcpServer` / `unregisterMcpServer` helpers
 * to keep the registry up to date. The playwright-mcp.ts extension has
 * been updated to do this automatically.
 *
 * Usage inside Pi TUI:
 *   /mcp                  — interactive menu
 *   /mcp list             — print all known MCP servers and their status
 *   /mcp tools <server>   — list all tools registered by a specific server
 *   /mcp tools            — list tools for every connected server
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Registry File ────────────────────────────────────────────────────────────

export const REGISTRY_PATH = join(homedir(), ".pi", "agent", "mcp-registry.json");

export interface McpServerEntry {
	/** Unique ID — same as the name you pass to `registerMcpServer` */
	id: string;
	/** Human-readable label, e.g. "Playwright MCP" */
	label: string;
	/** Unix timestamp (ms) when the server connected */
	connectedAt: number;
	/** "connected" | "error" | "disconnected" */
	status: "connected" | "error" | "disconnected";
	/** Optional error message when status === "error" */
	error?: string;
	/** Names of all tools this server registered with Pi */
	tools: string[];
}

// ─── Public helpers (re-exported for use in other extensions) ─────────────────

export function readRegistry(): McpServerEntry[] {
	try {
		if (!existsSync(REGISTRY_PATH)) return [];
		return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as McpServerEntry[];
	} catch {
		return [];
	}
}

export function writeRegistry(entries: McpServerEntry[]): void {
	try {
		writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2), "utf-8");
	} catch {
		// Non-fatal — registry is best-effort
	}
}

export function registerMcpServer(entry: Omit<McpServerEntry, "connectedAt">): void {
	const registry = readRegistry().filter((e) => e.id !== entry.id);
	registry.push({ ...entry, connectedAt: Date.now() });
	writeRegistry(registry);
}

export function unregisterMcpServer(id: string): void {
	const registry = readRegistry().map((e) =>
		e.id === id ? { ...e, status: "disconnected" as const } : e,
	);
	writeRegistry(registry);
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function statusIcon(status: McpServerEntry["status"]): string {
	switch (status) {
		case "connected":    return "🟢";
		case "error":        return "🔴";
		case "disconnected": return "⚫";
	}
}

function formatEntry(entry: McpServerEntry): string {
	const icon    = statusIcon(entry.status);
	const label   = entry.label;
	const status  = entry.status.toUpperCase();
	const age     = formatAge(entry.connectedAt);
	const toolCnt = entry.tools.length;
	const errLine = entry.error ? `\n    Error   : ${entry.error}` : "";

	return (
		`${icon}  ${label}  [${status}]\n` +
		`    ID      : ${entry.id}\n` +
		`    Since   : ${age}\n` +
		`    Tools   : ${toolCnt} registered${errLine}`
	);
}

function formatAge(ts: number): string {
	const secs = Math.floor((Date.now() - ts) / 1000);
	if (secs < 60)  return `${secs}s ago`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
	return `${Math.floor(secs / 3600)}h ago`;
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function mcpStatusExtension(pi: ExtensionAPI) {
	pi.registerCommand("mcp", {
		description: "Inspect active MCP servers and their tools. /mcp [list|tools [<server-id>]]",

		getArgumentCompletions: (prefix) => {
			const subcommands = ["list", "tools"];
			const p = prefix?.trim() ?? "";

			// If the user hasn't typed a space yet, complete the sub-command
			if (!p.includes(" ")) {
				return subcommands
					.filter((s) => s.startsWith(p))
					.map((s) => ({ value: s, label: s }));
			}

			// After "tools ", complete server IDs
			if (p.startsWith("tools ")) {
				const idPrefix = p.slice(6);
				return readRegistry()
					.filter((e) => e.status === "connected" && e.id.startsWith(idPrefix))
					.map((e) => ({ value: `tools ${e.id}`, label: `tools ${e.id} — ${e.label}` }));
			}

			return null;
		},

		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// ── /mcp (no args) → interactive menu ──────────────────────────
			if (!trimmed) {
				const registry = readRegistry();
				const menuItems = [
					"📋  List all MCP servers",
					"🔧  List all MCP tools",
					"——————————————————————",
					...registry.map(
						(e) =>
							`${statusIcon(e.status)}  ${e.label}  (${e.tools.length} tools)`,
					),
				];

				if (registry.length === 0) {
					menuItems.push("  (no MCP servers registered yet)");
				}

				const selected = await ctx.ui.select("⚡ MCP Server Status", menuItems);
				if (!selected || selected.startsWith("——")) return;

				if (selected.startsWith("📋")) {
					showList(registry, ctx);
				} else if (selected.startsWith("🔧")) {
					showAllTools(registry, ctx);
				} else {
					// User picked a specific server entry
					const match = registry.find(
						(e) => selected.includes(e.label),
					);
					if (match) showServerTools(match, ctx);
				}
				return;
			}

			// ── /mcp list ──────────────────────────────────────────────────
			if (trimmed === "list") {
				showList(readRegistry(), ctx);
				return;
			}

			// ── /mcp tools [<id>] ──────────────────────────────────────────
			if (trimmed === "tools" || trimmed.startsWith("tools ")) {
				const registry = readRegistry();
				if (trimmed === "tools") {
					showAllTools(registry, ctx);
				} else {
					const id = trimmed.slice(6).trim();
					const entry = registry.find((e) => e.id === id);
					if (!entry) {
						ctx.ui.notify(
							`❌ No MCP server with ID "${id}" found.\nUse /mcp list to see registered servers.`,
							"error",
						);
					} else {
						showServerTools(entry, ctx);
					}
				}
				return;
			}

			// ── Unknown sub-command ────────────────────────────────────────
			ctx.ui.notify(
				"Usage:\n" +
				"  /mcp                  — interactive menu\n" +
				"  /mcp list             — list all MCP servers\n" +
				"  /mcp tools            — list tools from every server\n" +
				"  /mcp tools <id>       — list tools from a specific server",
				"info",
			);
		},
	});
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function showList(registry: McpServerEntry[], ctx: any): void {
	if (registry.length === 0) {
		ctx.ui.notify(
			"No MCP servers registered.\n\n" +
			"MCP servers register themselves when they connect.\n" +
			"The Playwright MCP server connects automatically on session start.",
			"info",
		);
		return;
	}

	const lines = registry.map(formatEntry).join("\n\n");
	ctx.ui.notify(`MCP Servers (${registry.length}):\n\n${lines}`, "info");
}

function showAllTools(registry: McpServerEntry[], ctx: any): void {
	const connected = registry.filter((e) => e.status === "connected");
	if (connected.length === 0) {
		ctx.ui.notify("No connected MCP servers found.\nUse /mcp list to see all servers.", "info");
		return;
	}

	const sections = connected.map((e) => {
		const tools = e.tools.length > 0
			? e.tools.map((t) => `  • ${t}`).join("\n")
			: "  (no tools registered)";
		return `${statusIcon(e.status)}  ${e.label}\n${tools}`;
	});

	const total = connected.reduce((n, e) => n + e.tools.length, 0);
	ctx.ui.notify(
		`MCP Tools (${total} across ${connected.length} server${connected.length === 1 ? "" : "s"}):\n\n${sections.join("\n\n")}`,
		"info",
	);
}

function showServerTools(entry: McpServerEntry, ctx: any): void {
	const toolLines = entry.tools.length > 0
		? entry.tools.map((t) => `  • ${t}`).join("\n")
		: "  (no tools registered)";

	ctx.ui.notify(
		`${statusIcon(entry.status)}  ${entry.label}\n\n` +
		`Status : ${entry.status}\n` +
		`Tools  : ${entry.tools.length}\n\n` +
		toolLines,
		"info",
	);
}
