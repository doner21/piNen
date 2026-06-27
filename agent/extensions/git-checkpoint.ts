/**
 * Git Checkpoint Extension for Pi Code
 *
 * Automatically creates a git commit before any LLM-issued `write` or `edit`
 * tool call, providing a rollback point before destructive file operations.
 *
 * The commit uses --allow-empty so it always succeeds even if nothing changed.
 * Git failures are logged as warnings and never block the agent from working.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function gitCheckpointExtension(pi: ExtensionAPI) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const cwd = ctx.cwd;

    // spawnSync with detached:true + windowsHide:true — DETACHED_PROCESS
    // prevents conhost.exe allocation entirely (unlike CREATE_NO_WINDOW
    // which still creates a headless conhost). stdio:"pipe" captures
    // output synchronously. Non-zero exit is handled as a warning.
    const spawnOpts = { cwd, stdio: "pipe" as const, windowsHide: true, detached: true,
                        encoding: "buffer" as const };
    try {
      const addResult = spawnSync("git", ["add", "-u"], spawnOpts);
      if (addResult.status !== 0) {
        const errMsg = addResult.stderr?.toString()?.split("\n")[0] || `exit code ${addResult.status}`;
        throw new Error(errMsg);
      }
      const commitResult = spawnSync("git", ["commit", "-m", "checkpoint: pre-op auto-commit [pi]", "--allow-empty"], spawnOpts);
      if (commitResult.status !== 0) {
        const errMsg = commitResult.stderr?.toString()?.split("\n")[0] || `exit code ${commitResult.status}`;
        throw new Error(errMsg);
      }
    } catch (e) {
      console.warn("[git-checkpoint] git commit skipped:", (e as Error).message?.split("\n")[0]);
    }

    return undefined; // always allow the tool through — never block
  });
}
