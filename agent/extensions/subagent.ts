import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getPiChildFirstJsonTimeoutMs, isPiJsonProtocolEvent, killOwnedProcessTree, resolvePiChildCommand } from "./lib/pi-child-launch.ts";

interface AgentDef {
	name: string;
	description: string;
	systemPrompt: string;
	provider?: string;
	model?: string;
	tools?: string[];
	skills?: string[];
	agencyLevel?: "read-only" | "research" | "write-enabled";
	sourceFile: string;
}

interface JsonEventMessage {
	role?: string;
	content?: Array<{ type: string; text?: string }>;
	errorMessage?: string;
	stopReason?: string;
	error?: { message?: string };
}

interface ResolvedModelSelection {
	provider?: string;
	model?: string;
	thinkingLevel?: string;
}

interface SubagentOverride {
	model?: string;
	provider?: string;
	thinkingLevel?: string;
}

const agentsDir = join(homedir(), ".pi", "agent", "agents");
const skillsDir = join(homedir(), ".pi", "agent", "skills");
function resolveCliPath(): string {
	if (process.env.PI_CLI_PATH && existsSync(process.env.PI_CLI_PATH)) {
		return process.env.PI_CLI_PATH;
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
		const candidates = [
			join(appData, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
			join(appData, "npm", "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"),
		];
		for (const c of candidates) {
			if (existsSync(c)) return c;
		}
	} else {
		const candidates = [
			join(homedir(), ".npm-global", "lib", "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"),
			"/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
			"/usr/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
		];
		for (const c of candidates) {
			if (existsSync(c)) return c;
		}
	}
	throw new Error(
		"Pi CLI not found. Set PI_CLI_PATH environment variable to the cli.js path, or ensure pi-coding-agent is installed globally.",
	);
}

const agencyProfiles = {
	"read-only": {
		label: "read-only",
		description: "Can inspect files only. No edits.",
		tools: ["read", "grep", "find", "ls"],
	},
	research: {
		label: "research",
		description: "Read-only plus bash for investigation and web/search workflows.",
		tools: ["read", "bash", "grep", "find", "ls"],
	},
	"write-enabled": {
		label: "write-enabled",
		description: "Can inspect, run bash, and modify files.",
		tools: ["read", "bash", "edit", "write"],
	},
} as const;

type AgencyLevel = keyof typeof agencyProfiles;

function ensureCliPath(): string {
	return resolveCliPath();
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } | null {
	if (!content.startsWith("---\n")) return null;
	const end = content.indexOf("\n---\n", 4);
	if (end === -1) return null;
	const raw = content.slice(4, end);
	const body = content.slice(end + 5);
	const data: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key) data[key] = value;
	}
	return { data, body };
}

function normalizeAgencyLevel(level?: string): AgencyLevel | undefined {
	if (!level) return undefined;
	if (level === "read-only" || level === "research" || level === "write-enabled") return level;
	return undefined;
}

function normalizeTools(raw?: string | string[], agencyLevel?: AgencyLevel): string[] {
	if (Array.isArray(raw)) return raw.map((v) => v.trim()).filter(Boolean);
	if (typeof raw === "string" && raw.trim()) return raw.split(",").map((v) => v.trim()).filter(Boolean);
	if (agencyLevel) return [...agencyProfiles[agencyLevel].tools];
	return [];
}

function loadJsonAgent(path: string): AgentDef | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as {
			name?: string;
			description?: string;
			systemPrompt?: string;
			provider?: string;
			model?: string;
			tools?: string | string[];
			skills?: string[];
			agencyLevel?: string;
		};
		if (!raw.name || !raw.description || !raw.systemPrompt) return null;
		const agencyLevel = normalizeAgencyLevel(raw.agencyLevel);
		return {
			name: raw.name,
			description: raw.description,
			systemPrompt: raw.systemPrompt,
			provider: raw.provider,
			model: raw.model,
			tools: normalizeTools(raw.tools, agencyLevel),
			skills: raw.skills ?? [],
			agencyLevel,
			sourceFile: path,
		};
	} catch {
		return null;
	}
}

function loadMarkdownAgent(path: string): AgentDef | null {
	try {
		const parsed = parseFrontmatter(readFileSync(path, "utf-8"));
		if (!parsed) return null;
		const { data, body } = parsed;
		if (!data.name || !data.description) return null;
		const agencyLevel = normalizeAgencyLevel(data.agencyLevel);
		return {
			name: data.name,
			description: data.description,
			systemPrompt: body.trim(),
			provider: data.provider,
			model: data.model,
			tools: normalizeTools(data.tools, agencyLevel),
			skills: data.skills?.split(",").map((v) => v.trim()).filter(Boolean) ?? [],
			agencyLevel,
			sourceFile: path,
		};
	} catch {
		return null;
	}
}

function loadAgents(): AgentDef[] {
	if (!existsSync(agentsDir)) return [];
	const map = new Map<string, AgentDef>();
	for (const entry of readdirSync(agentsDir)) {
		const path = join(agentsDir, entry);
		const agent = entry.endsWith(".json")
			? loadJsonAgent(path)
			: entry.endsWith(".md")
				? loadMarkdownAgent(path)
				: null;
		if (agent) map.set(agent.name, agent);
	}
	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getFinalAssistantText(messages: JsonEventMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !msg.content) continue;
		const text = msg.content
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function getLastErrorMessage(messages: JsonEventMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].errorMessage) return messages[i].errorMessage;
	}
	return undefined;
}

function toSafeFileStem(name: string): string {
	const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	return cleaned || "agent";
}

function isLocalModel(provider?: string, model?: string): boolean {
	const p = (provider || "").toLowerCase();
	const m = (model || "").toLowerCase();
	return p === "ollama" || m.includes("llama") || m.includes("gemma");
}

function resolveModelSelection(agent: AgentDef, ctx: any, allowLocalModel?: boolean, overrides?: SubagentOverride): ResolvedModelSelection {
	const provider = overrides?.provider ?? agent.provider ?? ctx.model?.provider;
	const model = overrides?.model ?? agent.model ?? ctx.model?.id;
	const thinkingLevel = overrides?.thinkingLevel;
	if (!allowLocalModel && isLocalModel(provider, model)) {
		const source = agent.provider || agent.model ? "subagent config" : "current parent session model";
		throw new Error(
			[
				`Local model blocked for subagent '${agent.name}'.`,
				`Resolved model: ${provider || "unknown"}/${model || "unknown"}`,
				`Source: ${source}`,
				"Subagents do not use local Ollama/Llama/Gemma models unless explicitly allowed.",
				"To proceed, either:",
				"1. switch the parent session to a non-local model, or",
				"2. run '/subagents spawn --allow-local <agent> <task>', or",
				"3. call the subagent tool with allowLocalModel=true",
			].join("\n"),
		);
	}
	return { provider, model, thinkingLevel };
}

function saveAgent(agent: Omit<AgentDef, "sourceFile">): { filePath: string; agent: AgentDef } {
	const base = toSafeFileStem(agent.name);
	let candidate = base;
	let index = 1;
	while (existsSync(join(agentsDir, `${candidate}.json`)) || existsSync(join(agentsDir, `${candidate}.md`))) {
		candidate = `${base}-${index++}`;
	}
	const filePath = join(agentsDir, `${candidate}.json`);
	writeFileSync(
		filePath,
		JSON.stringify(
			{
				name: agent.name,
				description: agent.description,
				systemPrompt: agent.systemPrompt,
				provider: agent.provider,
				model: agent.model,
				tools: agent.tools ?? [],
				skills: agent.skills ?? [],
				agencyLevel: agent.agencyLevel,
			},
			null,
			2,
		),
		"utf-8",
	);
	return { filePath, agent: { ...agent, sourceFile: filePath } };
}

async function runSubagent(
	agent: AgentDef,
	task: string,
	cwd: string | undefined,
	ctx: any,
	signal?: AbortSignal,
	allowLocalModel?: boolean,
	modelOverride?: SubagentOverride,
): Promise<string> {
	const cli = ensureCliPath();
	const command = resolvePiChildCommand(cli);
	const args: string[] = [...command.argsPrefix, "--mode", "json", "-p", "--no-session"];
	const { provider, model, thinkingLevel } = resolveModelSelection(agent, ctx, allowLocalModel, modelOverride);
	if (provider) args.push("--provider", provider);
	if (model) args.push("--model", model);
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	for (const skill of agent.skills ?? []) {
		const skillPath = join(skillsDir, skill);
		if (existsSync(skillPath)) args.push("--skill", skillPath);
	}
	args.push("--append-system-prompt", agent.systemPrompt);

	return await new Promise<string>((resolve, reject) => {
		const child = spawn(command.command, args, {
			cwd: cwd || ctx.cwd,
			env: command.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: command.shell ?? false,
			windowsHide: true,
		});

		const messages: JsonEventMessage[] = [];
		let stdoutBuffer = "";
		let stderr = "";
		let aborted = false;
		let agentEnded = false;
		let protocolTimedOut = false;
		let firstJsonProtocolEventSeen = false;
		const firstJsonTimeoutMs = getPiChildFirstJsonTimeoutMs(command.env ?? process.env);
		const firstJsonTimer = setTimeout(() => {
			protocolTimedOut = true;
			stderr += `\nPI_CHILD_FIRST_JSON_TIMEOUT: no valid JSON protocol event within ${firstJsonTimeoutMs}ms from ${basename(command.command)}; terminating owned child tree.`;
			try { child.kill("SIGTERM"); } catch {}
			killOwnedProcessTree(child.pid, "first-json-timeout");
		}, firstJsonTimeoutMs);
		firstJsonTimer.unref?.();
		const markFirstJsonProtocolEvent = () => {
			if (firstJsonProtocolEventSeen) return;
			firstJsonProtocolEventSeen = true;
			clearTimeout(firstJsonTimer);
		};
		const assistantFailures: string[] = [];
		// WS-BUG fix (see WS-BUG-DIAGNOSIS-REPORT.md §2.3/§4, 2026-07-06):
		// failures that the child auto-retried are moved here instead of
		// poisoning the final verdict; they are reported as a footnote only.
		const recoveredFailures: string[] = [];

		const parseLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as {
					type?: string;
					message?: JsonEventMessage;
					stopReason?: string;
					errorMessage?: string;
					error?: { message?: string };
				};
				if (isPiJsonProtocolEvent(event)) markFirstJsonProtocolEvent();

				// F3: Track agent_end so post-termination message_end is not
				// mistaken for a failure (mirrors substrate.ts event-tracking).
				// WS-BUG fix (§4.1): respect the child's retry lifecycle. When
				// agent_end carries willRetry=true the child AgentSession is
				// about to auto-retry the errored turn (agent-session.js
				// _handlePostAgentRun/_prepareRetry), so this run's latched
				// failures are transient: park them and keep tracking the next run.
				if (event.type === "agent_end") {
					if ((event as { willRetry?: boolean }).willRetry === true) {
						recoveredFailures.push(...assistantFailures);
						assistantFailures.length = 0;
						agentEnded = false;
					} else {
						agentEnded = true;
					}
				}

				// WS-BUG fix (§4.1, belt-and-braces): a successful auto_retry_end
				// also means earlier latched failures were recovered.
				if (event.type === "auto_retry_end" && (event as { success?: boolean }).success === true) {
					recoveredFailures.push(...assistantFailures);
					assistantFailures.length = 0;
				}

				if (event.type === "message_end" && event.message) {
					messages.push(event.message);

					// F3: Extract stopReason / errorMessage from assistant
					// message_end events before agent_end (mirrors
					// substrate.ts failure-detection machinery).
					if (event.message.role === "assistant" && !agentEnded) {
						const stopReason =
							event.message.stopReason ??
							event.stopReason;
						const errorMessage =
							event.message.errorMessage ??
							event.errorMessage ??
							event.message.error?.message ??
							event.error?.message;
						const normalizedStopReason = stopReason?.toLowerCase();
						if (normalizedStopReason === "error" || normalizedStopReason === "aborted") {
							assistantFailures.push(`assistant stopReason=${stopReason}`);
						}
						if (errorMessage) assistantFailures.push(`assistant errorMessage=${errorMessage}`);
					}
				}
			} catch {}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf-8");
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) parseLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});

		child.on("error", (error) => {
			clearTimeout(firstJsonTimer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(firstJsonTimer);
			if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
			if (aborted) return reject(new Error(`Subagent ${agent.name} aborted`));
			if (protocolTimedOut) {
				return reject(new Error(JSON.stringify({
					type: "pi_child_first_json_timeout",
					agent: agent.name,
					timeoutMs: firstJsonTimeoutMs,
					pid: child.pid,
					cwd: cwd || ctx.cwd,
					commandBasename: basename(command.command),
					launchRuntime: command.launchRuntime,
				})));
			}
			const finalText = getFinalAssistantText(messages);
			const errorMessage = getLastErrorMessage(messages);

			if (code !== 0 && !finalText) {
				return reject(new Error(errorMessage || stderr || `Subagent ${agent.name} exited with code ${code ?? 1}`));
			}

			// F3: Exit 0 + no assistant text + no stderr = silent-empty
			// failure (observed under openai-codex OAuth where the
			// subagent auth path differs from orchestrate subprocesses).
			if (!finalText && !stderr.trim()) {
				const failureDetail = assistantFailures.length > 0
					? assistantFailures.join("; ")
					: "no assistant text produced";
				return reject(new Error(
					`Subagent ${agent.name} produced no output despite exit code 0. ` +
					`${failureDetail}. ` +
					`This usually indicates an auth/provider issue (e.g. OAuth token refresh, missing API key).`,
				));
			}

			// WS-BUG fix (§4.2): judge the run by its LAST assistant message,
			// not by a failure list latched from the child's first run. Only
			// reject when the FINAL outcome is an error (no successful
			// completion after the failure). Failures cleared via willRetry /
			// auto_retry_end above no longer poison a recovered run.
			const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
			const lastStopReason = lastAssistant?.stopReason?.toLowerCase();
			const terminalError = lastStopReason === "error" || lastStopReason === "aborted";

			if (terminalError || assistantFailures.length > 0) {
				// Genuine unrecovered failure at end-of-run. Reject with a
				// STRUCTURED message (bug-note suggested fix): classification,
				// cwd, terminal + transient errors, and any last assistant text,
				// so the orchestrator can check the filesystem for partial work.
				const stderrSuffix = stderr.trim()
					? `\nstderr: ${stderr.trim().slice(0, 500)}`
					: "";
				return reject(new Error(
					[
						`Subagent ${agent.name} terminal transport/assistant failure despite exit code 0 — classification: artifacts_may_exist`,
						`cwd: ${cwd || ctx.cwd}`,
						`terminal error: ${lastAssistant?.errorMessage ?? errorMessage ?? "unknown"}`,
						assistantFailures.length > 0 ? `final-run failures: ${assistantFailures.join("; ")}` : "",
						recoveredFailures.length > 0 ? `earlier transient errors (auto-retried by child): ${recoveredFailures.join("; ")}` : "",
						finalText
							? `--- last assistant text before failure ---\n${finalText.slice(0, 2000)}`
							: "(no assistant text captured)",
						`ACTION REQUIRED: inspect the filesystem for completed artifacts before re-running.${stderrSuffix}`,
					].filter(Boolean).join("\n"),
				));
			}

			// Success path. If the child auto-recovered transient stream errors
			// (e.g. "Connection error.", "WebSocket error"), annotate as a
			// footnote instead of failing the whole tool call.
			let result = finalText || stderr || `(subagent ${agent.name} produced no output)`;
			if (recoveredFailures.length > 0 && finalText) {
				result += `\n\n[subagent transport note: transient stream error(s) auto-recovered by child retry: ${recoveredFailures.join("; ")}]`;
			}
			resolve(result);
		});

		child.stdin.write(task);
		child.stdin.end();

		if (signal) {
			const stop = () => {
				aborted = true;
				clearTimeout(firstJsonTimer);
				try { child.kill("SIGTERM"); } catch {}
				killOwnedProcessTree(child.pid, "abort");
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {}
					killOwnedProcessTree(child.pid, "abort-hard-kill");
				}, 1500).unref?.();
			};
			if (signal.aborted) stop();
			else signal.addEventListener("abort", stop, { once: true });
		}
	});
}

function formatAgent(agent: AgentDef): string {
	const tools = agent.tools?.join(", ") || "default";
	const model = [agent.provider, agent.model].filter(Boolean).join("/") || "current model";
	const agencyLevel = agent.agencyLevel || (agent.tools?.includes("write") || agent.tools?.includes("edit") ? "write-enabled" : agent.tools?.includes("bash") ? "research" : "read-only");
	return `${agent.name} — ${agent.description}\n  agency: ${agencyLevel}\n  model: ${model}\n  tools: ${tools}`;
}

function getTemplate(choice: string): Pick<AgentDef, "description" | "systemPrompt" | "skills"> {
	if (choice.startsWith("Research")) {
		return {
			description: "Research specialist for web and codebase investigation",
			systemPrompt:
				"You are a focused research subagent. Investigate the task using available tools, gather evidence, and return a concise summary with findings, risks, and references. Do not edit files.",
			skills: ["internet-research"],
		};
	}
	if (choice.startsWith("Planner")) {
		return {
			description: "Planning specialist for scoped implementation plans",
			systemPrompt:
				"You are a planning subagent. Produce a concrete, phased plan with constraints, risks, and recommended next steps. Do not edit files.",
			skills: [],
		};
	}
	if (choice.startsWith("Reviewer")) {
		return {
			description: "Review specialist for bugs, regressions, and design issues",
			systemPrompt:
				"You are a review subagent. Inspect the task and relevant code, then return prioritized findings, risks, and recommendations. Do not edit files.",
			skills: [],
		};
	}
	if (choice.startsWith("Coder")) {
		return {
			description: "Implementation specialist that can modify files when allowed",
			systemPrompt:
				"You are a coding subagent. Implement the task cleanly and safely. Explain changes briefly, keep output concise, and verify your work before finishing.",
			skills: [],
		};
	}
	return {
		description: "Custom subagent",
		systemPrompt: "You are a helpful specialized subagent. Complete the delegated task and return a concise result.",
		skills: [],
	};
}

export default function subagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Spawn a named subagent in its own isolated Pi context window and return its condensed result.",
		promptSnippet: "Delegate focused work to a named subagent with an isolated context window.",
		promptGuidelines: [
			"Use subagent for research, planning, review, or isolated implementation tasks that should not consume the main context window.",
			"Pass a focused task and a known agent name.",
			"Optional: pass model / provider / thinkingLevel to override the subagent's configured model per-call (e.g. model: 'gpt-5.5', provider: 'openai-codex').",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "The subagent name from ~/.pi/agent/agents" }),
			task: Type.String({ description: "The delegated task for the subagent" }),
			cwd: Type.Optional(Type.String({ description: "Optional working directory override" })),
			allowLocalModel: Type.Optional(Type.Boolean({ description: "Set true only when you explicitly want to allow a local Ollama/Llama/Gemma model for this subagent." })),
			model: Type.Optional(Type.String({ description: "Override model for this subagent call (e.g. gpt-5.5, deepseek-v4-pro). If omitted, the agent's configured model or the parent session model is used." })),
			provider: Type.Optional(Type.String({ description: "Override provider for this subagent call (e.g. openai-codex, deepseek). If omitted, the agent's configured provider or the parent session provider is used." })),
			thinkingLevel: Type.Optional(Type.String({ description: "Optional thinking level override for this subagent call." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agents = loadAgents();
			const agent = agents.find((entry) => entry.name === params.agent);
			if (!agent) {
				const available = agents.map((entry) => entry.name).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown subagent: ${params.agent}. Available: ${available}` }],
					isError: true,
					details: { availableAgents: agents.map((entry) => entry.name) },
				};
			}

			// F4: Build per-call model/provider/thinkingLevel overrides.
			const modelOverride: SubagentOverride | undefined =
				params.model || params.provider || params.thinkingLevel
					? {
							model: params.model as string | undefined,
							provider: params.provider as string | undefined,
							thinkingLevel: params.thinkingLevel as string | undefined,
					  }
					: undefined;

			// F4: Resolve model inside try so local-model blocking errors
			// are caught by the structured error path (was outside, causing
			// unhandled promise rejections in the no-override path).
			let resolvedModel: ResolvedModelSelection;
			try {
				resolvedModel = resolveModelSelection(agent, ctx, params.allowLocalModel, modelOverride);
			} catch (error: any) {
				// resolveModelSelection can throw for local-model blocking —
				// surface it through the same structured error path as runSubagent failures.
				try {
					pi.events.emit("subagent:exit", {
						agentName: params.agent,
						exitCode: 1,
						endTime: new Date().toISOString(),
						errorMessage: error?.message,
						model: modelOverride?.model ?? agent.model ?? ctx.model?.id,
						provider: modelOverride?.provider ?? agent.provider ?? ctx.model?.provider,
					});
				} catch { /* events are best-effort */ }
				return {
					content: [{ type: "text", text: error?.message || `Subagent ${agent.name} failed` }],
					isError: true,
					details: { agent: agent.name, sourceFile: agent.sourceFile },
					metadata: { agent: agent.name, sourceFile: agent.sourceFile },
				};
			}

			// Emit subagent:spawn event for orchestration status panel
			try {
				pi.events.emit("subagent:spawn", {
					agentName: agent.name,
					task: params.task,
					model: resolvedModel.model ?? ctx.model?.id,
					provider: resolvedModel.provider ?? ctx.model?.provider,
					startTime: new Date().toISOString(),
				});
			} catch { /* events are best-effort; never break the main flow */ }

			try {
				const result = await runSubagent(agent, params.task, params.cwd, ctx, signal, params.allowLocalModel, modelOverride);
				try {
					pi.events.emit("subagent:exit", {
						agentName: agent.name,
						exitCode: 0,
						endTime: new Date().toISOString(),
						model: resolvedModel.model ?? ctx.model?.id,
						provider: resolvedModel.provider ?? ctx.model?.provider,
					});
				} catch { /* events are best-effort */ }
				return {
					content: [{ type: "text", text: result }],
					details: {
						agent: agent.name,
						description: agent.description,
						agencyLevel: agent.agencyLevel,
						model: resolvedModel.model ?? ctx.model?.id,
						provider: resolvedModel.provider ?? ctx.model?.provider,
						tools: agent.tools ?? [],
						sourceFile: agent.sourceFile,
					},
					metadata: {
						agent: agent.name,
						agencyLevel: agent.agencyLevel,
						model: resolvedModel.model ?? ctx.model?.id ?? "unknown",
						provider: resolvedModel.provider ?? ctx.model?.provider ?? "unknown",
						sourceFile: agent.sourceFile,
						resultLength: result.length,
						cwd: params.cwd ?? ctx.cwd,
					},
				};
			} catch (error: any) {
				try {
					pi.events.emit("subagent:exit", {
						agentName: params.agent,
						exitCode: 1,
						endTime: new Date().toISOString(),
						errorMessage: error?.message,
						model: resolvedModel.model ?? ctx.model?.id,
						provider: resolvedModel.provider ?? ctx.model?.provider,
					});
				} catch { /* events are best-effort */ }
				return {
					content: [{ type: "text", text: error?.message || `Subagent ${agent.name} failed` }],
					isError: true,
					details: { agent: agent.name, sourceFile: agent.sourceFile },
				metadata: { agent: agent.name, sourceFile: agent.sourceFile },
				};
			}
		},
	});

	pi.registerCommand("subagents", {
		description: "Manage subagents: list, spawn, create",
		getArgumentCompletions: (prefix) => {
			const base = ["list", "spawn", "create"];
			if (!prefix || !prefix.includes(" ")) {
				return base.filter((item) => item.startsWith(prefix || "")).map((item) => ({ value: item, label: item }));
			}
			if (prefix.startsWith("spawn ")) {
				const remainder = prefix.slice(6);
				if (!remainder.includes(" ")) {
					return loadAgents()
						.filter((agent) => agent.name.startsWith(remainder))
						.map((agent) => ({ value: `spawn ${agent.name} `, label: `${agent.name} — ${agent.description}` }));
				}
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const agents = loadAgents();

			const showList = async () => {
				if (agents.length === 0) {
					ctx.ui.notify("No subagents found in ~/.pi/agent/agents", "info");
					return;
				}
				ctx.ui.notify(`Available subagents:\n\n${agents.map(formatAgent).join("\n\n")}`, "info");
			};

			const handleSpawn = async (agentName?: string, providedTask?: string, allowLocalModel = false) => {
				let agent = agentName ? agents.find((entry) => entry.name === agentName) : undefined;
				if (!agent) {
					const choice = await ctx.ui.select(
						"Choose a subagent",
						agents.map((entry) => `${entry.name} — ${entry.description}`),
					);
					if (!choice) return;
					const selectedName = choice.split(" — ")[0];
					agent = agents.find((entry) => entry.name === selectedName);
				}
				if (!agent) {
					ctx.ui.notify("Subagent not found.", "error");
					return;
				}
				const task = providedTask || (await ctx.ui.input(`Task for ${agent.name}`, "Describe the delegated task"));
				if (!task) return;
				ctx.ui.notify(`Running subagent ${agent.name}...`, "info");
				try {
					const result = await runSubagent(agent, task, undefined, ctx, undefined, allowLocalModel);
					ctx.ui.notify(`Subagent ${agent.name} finished:\n\n${result}`, "info");
				} catch (error: any) {
					ctx.ui.notify(`Subagent ${agent.name} failed:\n${error?.message || error}`, "error");
				}
			};

			const handleCreate = async () => {
				const template =
					(await ctx.ui.select("Choose a starter template", ["Research", "Planner", "Reviewer", "Coder", "Blank"])) ||
					"Blank";
				const agencyChoice =
					(await ctx.ui.select("Choose agency level", [
						"read-only — inspect only, no writes",
						"research — read + bash, no writes",
						"write-enabled — can edit/write files",
					])) || "read-only — inspect only, no writes";
				const agencyLevel = agencyChoice.startsWith("research")
					? "research"
					: agencyChoice.startsWith("write-enabled")
						? "write-enabled"
						: "read-only";
				const seed = getTemplate(template);
				const name = await ctx.ui.input("Agent name", `e.g. ${template.toLowerCase()}-agent`);
				if (!name?.trim()) return;
				const description =
					(await ctx.ui.input("Agent description", seed.description)) || seed.description;
				const systemPrompt =
					(await ctx.ui.editor("Edit system prompt", seed.systemPrompt)) || seed.systemPrompt;
				const provider = await ctx.ui.input("Provider (blank = inherit current model at runtime)", "");
				const model = await ctx.ui.input("Model (blank = inherit current model at runtime)", "");
				const skillsText = await ctx.ui.input("Skills (comma-separated, optional)", seed.skills.join(", "));
				const skills = skillsText ? skillsText.split(",").map((v: string) => v.trim()).filter(Boolean) : [];
				const tools = [...agencyProfiles[agencyLevel as AgencyLevel].tools];
				if (isLocalModel(provider || undefined, model || undefined)) {
					const localOk = await ctx.ui.confirm(
						"Allow local model for this subagent?",
						"This agent is configured with a local/Ollama/Llama/Gemma model. It will be blocked by default unless you explicitly allow local models at runtime.",
					);
					if (!localOk) return;
				}
				const ok = await ctx.ui.confirm(
					`Create subagent ${name.trim()}?`,
					[
						`description: ${description}`,
						`agency: ${agencyLevel}`,
						`tools: ${tools.join(", ")}`,
						`provider/model: ${provider || "inherit"}/${model || "inherit"}`,
						`skills: ${skills.join(", ") || "none"}`,
					].join("\n"),
				);
				if (!ok) return;
				const saved = saveAgent({
					name: name.trim(),
					description,
					systemPrompt,
					provider: provider || undefined,
					model: model || undefined,
					tools,
					skills,
					agencyLevel: agencyLevel as AgencyLevel,
				});
				ctx.ui.notify(`Created subagent ${saved.agent.name}\nfile: ${saved.filePath}`, "info");
			};

			if (!trimmed) {
				const choice = await ctx.ui.select("Subagents", ["List", "Spawn", "Create"]);
				if (!choice) return;
				if (choice === "List") return await showList();
				if (choice === "Spawn") return await handleSpawn();
				if (choice === "Create") return await handleCreate();
				return;
			}

			if (trimmed === "list") return await showList();
			if (trimmed === "create") return await handleCreate();
			if (trimmed.startsWith("spawn")) {
				const rest = trimmed.slice(5).trim();
				const localPrefix = "--allow-local ";
				const allowLocalModel = rest.startsWith(localPrefix);
				const normalized = allowLocalModel ? rest.slice(localPrefix.length).trim() : rest;
				if (!normalized) return await handleSpawn(undefined, undefined, allowLocalModel);
				const firstSpace = normalized.indexOf(" ");
				if (firstSpace === -1) return await handleSpawn(normalized, undefined, allowLocalModel);
				const agentName = normalized.slice(0, firstSpace).trim();
				const task = normalized.slice(firstSpace + 1).trim();
				return await handleSpawn(agentName, task || undefined, allowLocalModel);
			}

			ctx.ui.notify("Usage:\n/subagents\n/subagents list\n/subagents spawn <agent> <task>\n/subagents spawn --allow-local <agent> <task>\n/subagents create", "info");
		},
	});
}
