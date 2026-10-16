import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const NO_OUTPUT_MONITOR_NOT_READY_REASON =
  "NO_OUTPUT_MONITOR_NOT_READY: bash dispatch was blocked because the mandatory monitor was not constructed.";

/** Fail-closed construction gate loaded for every worker before the monitor. */
export default function workerMonitorBootstrap(pi: ExtensionAPI): void {
  let ready = false;
  pi.events.on("orchestrator:no-output-monitor-ready", (value) => {
    if (value && typeof value === "object" && (value as { version?: unknown }).version === 1) ready = true;
  });
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && !ready) return { block: true, reason: NO_OUTPUT_MONITOR_NOT_READY_REASON };
    return undefined;
  });
}
