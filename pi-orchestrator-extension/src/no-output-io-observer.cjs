#!/usr/bin/env node
/** Minimal trusted lifecycle/transport preload. Filesystem activity is observed externally. */
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const workerThreads = require("node:worker_threads");

if (workerThreads.isMainThread && process.env.PI_ORC_IO_OBSERVER === "1") {
  const transportWrite = fs.writeSync.bind(fs);
  let sequence = 0;
  let channelFailed = false;
  let descendantObserved = false;
  let transportConfig;
  try {
    const text = fs.readFileSync(4, "utf8");
    if (text && Buffer.byteLength(text, "utf8") <= 64 * 1024) transportConfig = JSON.parse(text);
  } catch {}
  const emit = (payload) => {
    if (channelFailed) return;
    try { transportWrite(3, `${JSON.stringify({ schemaVersion: 1, sequence: ++sequence, ...payload })}\n`); }
    catch { channelFailed = true; }
  };

  emit({ type: "coverage_ready", workerThreadsSupported: true, filesystemObservation: "external-process-counters", transportReady: Boolean(transportConfig) });

  if (typeof process.dlopen === "function") {
    const originalDlopen = process.dlopen;
    process.dlopen = function (...args) {
      emit({ type: "unobservable_io_backend", api: "process.dlopen" });
      return originalDlopen.apply(this, args);
    };
  }

  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (command, args = [], options = {}) {
    let exactNode = false;
    try { exactNode = fs.realpathSync(command).toLowerCase() === fs.realpathSync(process.execPath).toLowerCase(); } catch {}
    if (transportConfig && exactNode && Array.isArray(args) && options.shell !== true && options.detached !== true) {
      emit({ type: "transport_child", supported: true });
      const effectiveEnv = { ...(options.env || process.env) };
      const userNodeOptions = effectiveEnv.NODE_OPTIONS || "";
      effectiveEnv.NODE_OPTIONS = "";
      effectiveEnv.PI_ORC_USER_NODE_OPTIONS = userNodeOptions;
      effectiveEnv.PI_ORC_NO_OUTPUT_AUTH = transportConfig.authKey;
      effectiveEnv.PI_ORC_NO_OUTPUT_ORIGINAL_PATH = effectiveEnv.PATH || effectiveEnv.Path || "";
      const helperArgs = [
        transportConfig.supervisorPath,
        "--event-dir", transportConfig.eventDir,
        "--evidence-root", transportConfig.evidenceRoot,
        "--command-id", transportConfig.commandId,
        "--policy", JSON.stringify(transportConfig.policy),
        "--authorization-file", transportConfig.authorizationFile,
        "--authorization-sha256", transportConfig.authorizationSha256,
        "--io-observer", transportConfig.ioObserverPath,
        "--host-managed-capture", "true",
        "--owner-config", JSON.stringify(transportConfig.ownerConfiguration),
        "--",
        ...args,
      ];
      return originalSpawn.call(this, process.execPath, helperArgs, { ...options, env: effectiveEnv, shell: false, detached: false });
    }
    if (!descendantObserved) { descendantObserved = true; emit({ type: "descendant_process", api: "spawn" }); }
    return originalSpawn.call(this, command, args, options);
  };

  for (const name of ["spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    const original = childProcess[name];
    if (typeof original !== "function") continue;
    childProcess[name] = function (...args) {
      if (!descendantObserved) { descendantObserved = true; emit({ type: "descendant_process", api: name }); }
      return original.apply(this, args);
    };
  }

  const OriginalWorker = workerThreads.Worker;
  if (typeof OriginalWorker === "function") {
    workerThreads.Worker = class ObservedWorker extends OriginalWorker {
      constructor(...args) {
        emit({ type: "worker_thread", supported: true });
        super(...args);
      }
    };
  }
}
