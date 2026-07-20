import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const COMMAND_NAME = "new-mock-process";
const TOOL_NAME = "new_mock_process";
const PENDING_RUN_FILE = join("agent", "new-mock-process-pending.json");
const LAST_RUN_FILE = join("agent", "new-mock-process-last-run.json");

type NewMockProcessSource = "command" | "tool" | "scheduled-reload";

function runNewMockProcess(ctx: ExtensionContext, source: NewMockProcessSource): string {
	const timestamp = new Date().toISOString();
	const message = `New mock process ran successfully from ${source} at ${timestamp}.`;
	const result = {
		message,
		ranAt: timestamp,
		source,
		command: COMMAND_NAME,
		tool: TOOL_NAME,
		cwd: ctx.cwd,
	};

	writeFileSync(join(ctx.cwd, LAST_RUN_FILE), JSON.stringify(result, null, 2), "utf-8");

	try {
		ctx.ui.notify(message, "info");
		ctx.ui.setWidget(COMMAND_NAME, [
			"New mock process extension",
			`Last run: ${timestamp}`,
			`Source: ${source}`,
			"This extension should exist only after Pi reloads extension resources.",
		]);
	} catch {
		// UI feedback is best-effort; the persisted result is the test evidence.
	}

	return message;
}

function runPendingNewMockProcessIfRequested(ctx: ExtensionContext): void {
	const pendingPath = join(ctx.cwd, PENDING_RUN_FILE);
	if (!existsSync(pendingPath)) return;

	let request: unknown = null;
	try {
		request = JSON.parse(readFileSync(pendingPath, "utf-8"));
	} catch {
		request = { malformed: true };
	}

	const message = runNewMockProcess(ctx, "scheduled-reload");
	const lastRunPath = join(ctx.cwd, LAST_RUN_FILE);
	const persisted = JSON.parse(readFileSync(lastRunPath, "utf-8"));
	writeFileSync(lastRunPath, JSON.stringify({ ...persisted, request, trigger: "session_start" }, null, 2), "utf-8");
	unlinkSync(pendingPath);
}

export default function newMockProcessExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		runPendingNewMockProcessIfRequested(ctx);
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Open and run the NEW harmless mock process for reload testing.",
		getArgumentCompletions: (prefix) => {
			const options = ["run", "status"];
			return options
				.filter((option) => option.startsWith(prefix.trim()))
				.map((option) => ({ value: option, label: option }));
		},
		handler: async (args, ctx) => {
			const mode = args.trim() || "run";

			if (mode === "status") {
				ctx.ui.notify(`/${COMMAND_NAME} and ${TOOL_NAME} are loaded and ready.`, "info");
				return;
			}

			if (mode !== "run") {
				ctx.ui.notify(`Unknown new mock process mode: ${mode}`, "error");
				return;
			}

			runNewMockProcess(ctx, "command");
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "New Mock Process",
		description: "Run the NEW harmless mock process from the reload-test extension.",
		promptSnippet: "Run or check the NEW mock process reload-test extension.",
		promptGuidelines: ["Use new_mock_process when the user asks the agent to run the new reload-test mock process."],
		parameters: Type.Object({
			mode: Type.Optional(Type.String({ description: "Use 'run' to run or 'status' to check readiness." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mode = params.mode?.trim() || "run";

			if (mode === "status") {
				return {
					content: [{ type: "text", text: `/${COMMAND_NAME} and ${TOOL_NAME} are loaded and ready.` }],
					details: { command: COMMAND_NAME, tool: TOOL_NAME, loaded: true },
				};
			}

			if (mode !== "run") {
				return {
					content: [{ type: "text", text: `Unknown new mock process mode: ${mode}` }],
					details: { command: COMMAND_NAME, tool: TOOL_NAME, loaded: true, mode },
					isError: true,
				};
			}

			const message = runNewMockProcess(ctx, "tool");
			return {
				content: [{ type: "text", text: message }],
				details: { command: COMMAND_NAME, tool: TOOL_NAME, loaded: true, ran: true },
			};
		},
	});
}
