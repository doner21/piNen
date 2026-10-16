import { spawnSync } from "node:child_process";

import type { ProcessInspector, ProcessObservation } from "./types";

/** Cross-platform process inspection with an OS-derived start identity for PID-reuse fencing. */
export class SystemProcessInspector implements ProcessInspector {
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  inspect(pid: number): ProcessObservation {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { pid, alive: false };
    if (process.platform === "win32") {
      const script = `try{$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction Stop}catch{exit 4}; if($null -eq $p){exit 3}; $p.CreationDate.ToUniversalTime().ToString(\"o\")`;
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        env: this.#env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        shell: false,
      });
      if (result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
        return { pid, alive: true, startedAt: normalizeProcessStartIdentity(result.stdout.trim(), "observed process start") };
      }
      if (result.status === 3) return { pid, alive: false };
      // A transport/CIM/timeout failure is uncertainty, not proof of death.
      // Represent it as possibly alive with no start identity so all fencing
      // callers fail closed.
      return { pid, alive: true };
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return { pid, alive: false };
    }
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5_000, shell: false });
    const raw = result.status === 0 ? result.stdout.trim() : "";
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    return { pid, alive: true, ...(Number.isFinite(parsed) ? { startedAt: new Date(parsed).toISOString() } : {}) };
  }
}

export function requireProcessStartIdentity(inspector: ProcessInspector, pid: number, label: string): string {
  const observation = inspector.inspect(pid);
  if (!observation.alive || !observation.startedAt) throw new Error(`${label}: process start identity unavailable for pid ${pid}`);
  return normalizeProcessStartIdentity(observation.startedAt, label);
}

export function normalizeProcessStartIdentity(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${label}: invalid process start identity`);
  return new Date(parsed).toISOString();
}
