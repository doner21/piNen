import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// NenFlow v3 now runs as a visible prompt-template + skill workflow.
// Use:
//   /nenflow_v3 <task>
// or:
//   /pev <task>
//
// These commands are provided by global prompt templates in:
//   %USERPROFILE%/.pi/agent/prompts/
//
// This extension is intentionally a no-op so Pi does not register a
// headless/background NenFlow command that hides model activity.

export default function nenflowV3GlobalStub(_pi: ExtensionAPI) {}
