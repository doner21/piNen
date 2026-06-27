import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function retiredAgentsExtension(pi: ExtensionAPI) {
	pi.registerCommand("agents", {
		description: "Deprecated. Use /subagents instead.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"/agents has been retired. Use /subagents instead.\n\nAvailable replacements:\n- /subagents list\n- /subagents spawn <agent> <task>\n- /subagents create",
				"info",
			);
		},
	});
}
