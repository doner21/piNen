/**
 * Confirm Destructive Extension for Pi Code
 *
 * Intercepts LLM-issued bash calls and user-typed !commands that match
 * dangerous patterns (rm -rf, mkfs, dd to device, etc.) and prompts the
 * user for confirmation before allowing execution.
 *
 * If no UI is available the command is blocked unconditionally.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function confirmDestructiveExtension(pi: ExtensionAPI) {

  // ─── Dangerous Pattern List ─────────────────────────────────────────────────

  const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
    { pattern: /\brm\b.*-[a-z]*[rf][a-z]*/i,          label: "rm with -r or -f flag" },
    { pattern: /\brm\b\s+-rf\b/i,                       label: "rm -rf" },
    { pattern: /\brm\b\s+-fr\b/i,                       label: "rm -fr" },
    { pattern: /\brmdir\b.*\/s\b/i,                      label: "rmdir /s (Windows recursive)" },
    { pattern: /\brd\b\s+\/s\b/i,                        label: "rd /s (Windows recursive)" },
    { pattern: /\bdel\b\s+\/[fs]/i,                      label: "del /f or del /s (Windows force delete)" },
    { pattern: /\bmkfs\b/i,                              label: "mkfs (format filesystem)" },
    { pattern: /\bformat\b\s+[a-z]:/i,                  label: "Windows format drive" },
    { pattern: /\bdd\b.*\bof=\/dev\//i,                  label: "dd writing to device" },
    { pattern: />\s*\/dev\/(sd[a-z]|nvme|hd[a-z])/i,   label: "redirect to raw disk device" },
    { pattern: /\bsudo\s+rm\b/i,                         label: "sudo rm" },
    { pattern: /\btruncate\b/i,                          label: "truncate command" },
    { pattern: /\bsudo\s+dd\b/i,                         label: "sudo dd" },
  ];

  // ─── Helper ──────────────────────────────────────────────────────────────────

  function matchesDangerous(command: string): string | null {
    for (const { pattern, label } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) return label;
    }
    return null;
  }

  // ─── Hook 1: tool_call (LLM-issued bash) ─────────────────────────────────────

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command as string;
    const matchLabel = matchesDangerous(command);
    if (!matchLabel) return;

    const title = "Dangerous Command Detected";
    const body = `The agent wants to run:\n\n  ${command}\n\nRisk: ${matchLabel}\n\nAllow this command?`;

    if (!ctx.hasUI) {
      return { block: true, reason: `Blocked: "${matchLabel}" — no UI available to confirm.` };
    }

    try {
      const confirmed = await ctx.ui.confirm(title, body);
      if (!confirmed) {
        return { block: true, reason: `User declined: "${matchLabel}"` };
      }
      return undefined; // allow
    } catch {
      return { block: true, reason: `Blocked: "${matchLabel}" — confirmation dialog failed.` };
    }
  });

  // ─── Hook 2: user_bash (user-typed !command) ──────────────────────────────────

  pi.on("user_bash", async (event: any, ctx: any) => {
    const matchLabel = matchesDangerous(event.command);
    if (!matchLabel) return;

    const title = "Dangerous Command Detected";
    const body = `You typed:\n\n  ${event.command}\n\nRisk: ${matchLabel}\n\nAllow this command?`;

    if (!ctx.hasUI) {
      return {
        result: {
          output: `[confirm-destructive] BLOCKED: "${matchLabel}" — no UI to confirm.`,
          exitCode: 1,
          isError: true,
          signal: null,
          timedOut: false,
        } as any
      };
    }

    try {
      const confirmed = await ctx.ui.confirm(title, body);
      if (!confirmed) {
        return {
          result: {
            output: `[confirm-destructive] BLOCKED by user: "${matchLabel}"`,
            exitCode: 1,
            isError: true,
            signal: null,
            timedOut: false,
          } as any
        };
      }
      return undefined; // allow
    } catch {
      return {
        result: {
          output: `[confirm-destructive] BLOCKED: "${matchLabel}" — confirmation dialog failed.`,
          exitCode: 1,
          isError: true,
          signal: null,
          timedOut: false,
        } as any
      };
    }
  });
}
