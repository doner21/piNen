#!/usr/bin/env node

/**
 * windows-spawn-eperm-trace.mjs
 * ==============================
 * Standalone, zero-Pi-imports diagnostic for Windows spawn EPERM failures.
 * Probes child-process creation with combinations of windowsHide, shell, and
 * visibility, captures parent-chain info, and optionally correlates against
 * Windows event logs (Defender, CodeIntegrity, AppLocker, Sysmon).
 *
 * Usage:
 *   node windows-spawn-eperm-trace.mjs [--artifact <path>] [--minutes <n>] [--out <path>] [--no-event-logs] [--dry-run]
 *
 * Output: JSON to stdout and, unless --dry-run, a timestamped JSON file under
 *          agent/diagnostics/spawn-eperm/.
 */

import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

// ── CLI parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  artifact: null,
  minutes: 10,
  out: null,
  noEventLogs: false,
  dryRun: false,
};

for (let i = 0; i < args.length; i++) {
  const token = args[i];
  if (token === "--artifact" || token === "-a") {
    flags.artifact = args[++i] ?? null;
  } else if (token === "--minutes" || token === "-m") {
    flags.minutes = parseInt(args[++i] ?? "10", 10) || 10;
  } else if (token === "--out" || token === "-o") {
    flags.out = args[++i] ?? null;
  } else if (token === "--no-event-logs") {
    flags.noEventLogs = true;
  } else if (token === "--dry-run" || token === "-n") {
    flags.dryRun = true;
  }
}

// ── Platform guard ───────────────────────────────────────────────────────

if (process.platform !== "win32") {
  console.log(JSON.stringify({ kind: "windows-spawn-eperm-trace", platform: process.platform, skipped: true, message: "This diagnostic only runs on Windows." }));
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Run a PowerShell command and return the parsed JSON output, or null on failure. */
async function powershellJson(script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      script,
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code !== 0) { resolve(null); return; }
      try { resolve(JSON.parse(stdout.trim())); }
      catch { resolve(null); }
    });
    child.on("error", () => resolve(null));
  });
}

/** Spawn a child and return probe result. Never captures stdout/stderr content. */
function spawnProbe(cmd, args, opts = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        windowsHide: true,
        stdio: "ignore",
        timeout: 10000,
        ...opts,
      });
      child.on("close", (code) => {
        resolve({
          label: opts.label ?? "spawn",
          ok: code === 0,
          code,
          durationMs: Date.now() - startedAt,
        });
      });
      child.on("error", (err) => {
        resolve({
          label: opts.label ?? "spawn",
          ok: false,
          code: err.code ?? null,
          errorCode: err.code,
          errorMessage: scrubMessageSnippet(err.message ?? String(err)),
          durationMs: Date.now() - startedAt,
        });
      });
    } catch (err) {
      resolve({
        label: opts.label ?? "spawn",
        ok: false,
        code: err.code ?? null,
        errorCode: err.code,
        errorMessage: scrubMessageSnippet(err.message ?? String(err)),
        durationMs: Date.now() - startedAt,
      });
    }
  });
}

/** Build env allowlist presence flags — only boolean presence, no values. */
function envAllowlistPresence() {
  return {
    PATH: "PATH" in process.env,
    PI_CLI_PATH: "PI_CLI_PATH" in process.env,
    PI_CLI: "PI_CLI" in process.env,
    USERPROFILE_basename: process.env.USERPROFILE ? path.basename(process.env.USERPROFILE) : null,
  };
}

/**
 * Aggressively scrub event log message snippets to remove command lines,
 * full paths, env/auth/session-looking strings, and other potentially
 * privacy-sensitive content. Returns sanitized text or empty string.
 */
function scrubMessageSnippet(msg) {
  if (!msg) return "";
  let s = String(msg).replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  // Remove Windows UNC / drive-letter full paths (3+ segments).
  s = s.replace(/[A-Za-z]:\\(?:[^\\\s"'<>;,!]{1,64}\\){2,}[^\\\s"'<>;,!]{1,128}/g, "[path-redacted]");
  // Remove paths with forward slashes that look like absolute paths.
  s = s.replace(/(?:\/(?:home|Users|var|opt|usr|tmp|etc|root)\/[^\s"'<>;,!]{1,64}(?:\/[^\s"'<>;,!]{1,64}){1,8})/g, "[path-redacted]");
  // Remove env-variable looking assignments (KEY=VALUE with value > 4 chars).
  s = s.replace(/\b[A-Z_]{2,30}=[^\s]{8,}/g, "[env-redacted]");
  // Remove obvious auth tokens / session IDs (hex/base64/base62 strings > 20 chars).
  s = s.replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[token-redacted]");
  // Remove command-line invocations: .exe/.cmd/.bat/.ps1 followed by args.
  s = s.replace(/\S+\.(?:exe|cmd|bat|ps1|dll|sys)(?:\s+[\-\/"'][^\s]{2,}){2,}/gi, "[command-redacted]");
  return s.slice(0, 200);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // Redact flags to avoid recording raw artifact/out paths.
  const safeFlags = {
    artifact: flags.artifact ? { hasValue: true, basename: path.basename(flags.artifact) } : { hasValue: false },
    minutes: flags.minutes,
    out: flags.out ? { hasValue: true, basename: path.basename(flags.out) } : { hasValue: false },
    noEventLogs: flags.noEventLogs,
    dryRun: flags.dryRun,
  };

  const evidence = {
    kind: "windows-spawn-eperm-trace",
    timestampUtc: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    pid: process.pid,
    ppid: process.ppid,
    execPath: path.basename(process.execPath),
    flags: safeFlags,
    envAllowlist: envAllowlistPresence(),
    probes: [],
    parentChain: null,
    eventLogs: null,
    artifactCorrelation: null,
  };

  // ── Probe: Basic spawn permutations ──────────────────────────────────

  evidence.probes.push(await spawnProbe(process.execPath, ["-v"], { label: "node -v windowsHide:true", windowsHide: true }));
  evidence.probes.push(await spawnProbe(process.execPath, ["-v"], { label: "node -v windowsHide:false", windowsHide: false, detached: false }));
  evidence.probes.push(await spawnProbe(process.execPath, ["-v"], { label: "node -v shell:true windowsHide:true", shell: true, windowsHide: true }));

  // PI_CLI_PATH probe: spawn node with the CLI path, --version if supported.
  const piCliPath = process.env.PI_CLI_PATH;
  if (piCliPath) {
    const versionArgs = [piCliPath, "--version"];
    evidence.probes.push(await spawnProbe(process.execPath, versionArgs, { label: "pi --version windowsHide:true", windowsHide: true }));
    evidence.probes.push(await spawnProbe(process.execPath, versionArgs, { label: "pi --version windowsHide:false", windowsHide: false, detached: false }));
  } else {
    evidence.probes.push({ label: "pi --version (skipped)", skipped: true, reason: "PI_CLI_PATH not set" });
  }

  // ── Parent-chain detection ───────────────────────────────────────────

  try {
    const parentScript = `
$targetPid = ${process.pid};
$chain = @();
$current = $targetPid;
$maxDepth = 16;
while ($current -and $chain.Count -lt $maxDepth) {
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -Property ProcessId,ParentProcessId,Name,CommandLine -ErrorAction Stop;
    if (-not $proc) { break }
    $chain += [ordered]@{
      pid = $proc.ProcessId
      ppid = $proc.ParentProcessId
      name = $proc.Name
    };
    if ($proc.ProcessId -eq 0 -or $proc.ParentProcessId -eq 0 -or $proc.ProcessId -eq $proc.ParentProcessId) { break }
    $current = $proc.ParentProcessId;
  } catch { break }
}
$chain | ConvertTo-Json -Compress;
`;
    evidence.parentChain = await powershellJson(parentScript);
  } catch {
    evidence.parentChain = { error: "Parent-chain detection failed." };
  }

  // ── Event log correlation ────────────────────────────────────────────

  if (!flags.noEventLogs && !flags.dryRun) {
    const minutes = Math.max(1, Math.min(flags.minutes, 60));
    const startTime = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const endTime = new Date().toISOString();

    const eventScript = `
$start = [datetime]'${startTime}';
$end   = [datetime]'${endTime}';
$logs = @(
  @{Name='Microsoft-Windows-Windows Defender/Operational'; Label='Defender Operational'},
  @{Name='Microsoft-Windows-CodeIntegrity/Operational'; Label='CodeIntegrity Operational'},
  @{Name='Microsoft-Windows-AppLocker/EXE and DLL'; Label='AppLocker EXE/DLL'},
  @{Name='Microsoft-Windows-AppLocker/MSI and Script'; Label='AppLocker MSI/Script'},
  @{Name='Microsoft-Windows-AppLocker/Packaged app-Deployment'; Label='AppLocker Packaged'},
  @{Name='Security'; Label='Security 4688'},
  @{Name='Microsoft-Windows-Sysmon/Operational'; Label='Sysmon Operational'}
);

$results = @();
foreach ($log in $logs) {
  try {
    $events = Get-WinEvent -FilterHashtable @{
      LogName = $log.Name
      StartTime = $start
      EndTime = $end
    } -MaxEvents 50 -ErrorAction Stop | Select-Object -First 50;
    foreach ($event in $events) {
      # Truncate raw message immediately; JS-side scrubMessageSnippet handles deeper sanitization.
      $msg = ($event.Message -replace '[\r\n]+',' ' -replace '\s+',' ').Trim();
      $snippet = if ($msg.Length -gt 500) { $msg.Substring(0, 497) + '...' } else { $msg };
      $results += [ordered]@{
        Provider = $event.ProviderName
        Id = $event.Id
        TimeCreated = $event.TimeCreated.ToString('o')
        Level = $event.LevelDisplayName
        LogName = $event.LogName
        MessageRaw = $snippet
      };
    }
  } catch {
    # Log not available or no events; skip silently.
  }
}
$results | ConvertTo-Json -Compress -Depth 3;
`;
    try {
      const rawLogs = await powershellJson(eventScript, 30000);
      if (!rawLogs) {
        evidence.eventLogs = { note: "Event log query returned no results or failed." };
      } else {
        // JS-side scrubbing: replace MessageRaw with sanitized MessageSnippet.
        const scrubbed = (Array.isArray(rawLogs) ? rawLogs : [rawLogs]).map((e) => {
          const snippet = scrubMessageSnippet(e.MessageRaw);
          const { MessageRaw, ...rest } = e;
          return { ...rest, MessageSnippet: snippet };
        });
        evidence.eventLogs = scrubbed;
      }
    } catch {
      evidence.eventLogs = { error: "Event log correlation failed." };
    }
  } else if (flags.dryRun) {
    evidence.eventLogs = { skipped: true, reason: "--dry-run active" };
  } else {
    evidence.eventLogs = { skipped: true, reason: "--no-event-logs active" };
  }

  // ── Artifact correlation ─────────────────────────────────────────────

  if (flags.artifact) {
    try {
      const { existsSync } = await import("node:fs");
      const artifactExists = existsSync(flags.artifact);
      if (artifactExists) {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(flags.artifact, "utf8");
        const parsed = JSON.parse(content);
        evidence.artifactCorrelation = {
          basename: path.basename(flags.artifact),
          loaded: true,
          exists: true,
          kind: parsed.kind ?? null,
          timestampUtc: parsed.timestampUtc ?? null,
          pid: parsed.pid ?? null,
          errorCode: parsed.error?.code ?? null,
        };
      } else {
        evidence.artifactCorrelation = { basename: path.basename(flags.artifact), loaded: false, exists: false };
      }
    } catch {
      evidence.artifactCorrelation = { basename: path.basename(flags.artifact), loaded: false, exists: false };
    }
  }

  // ── Output ───────────────────────────────────────────────────────────

  const json = JSON.stringify(evidence, null, 2);
  console.log(json);

  if (!flags.dryRun) {
    try {
      const outDir = flags.out
        ? path.dirname(path.resolve(flags.out))
        : path.resolve(process.cwd(), "agent", "diagnostics", "spawn-eperm");
      const outFile = flags.out
        ? path.resolve(flags.out)
        : path.join(outDir, `windows-spawn-trace-${Date.now()}.json`);
      await mkdir(outDir, { recursive: true });
      await writeFile(outFile, json, "utf8");
      console.error(`\nEvidence written to: ${outFile}`);
    } catch (err) {
      console.error(`\nFailed to write evidence file: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
