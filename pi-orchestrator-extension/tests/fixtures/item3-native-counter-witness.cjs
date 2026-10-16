"use strict";

// Native observations only. Product promises are recorded, never used as the
// liveness barrier: a broken product promise cannot hold the fixture open.
const { StringDecoder } = require("node:string_decoder");

function trackPromise(call) {
  const record = { status: "pending" };
  try {
    record.observed = Promise.resolve(call()).then(
      (value) => { record.status = "fulfilled"; record.value = value; },
      (error) => { record.status = "rejected"; record.error = error; },
    );
  } catch (error) { record.status = "rejected"; record.error = error; }
  record.snapshot = () => ({ status: record.status, value: record.value,
    error: record.error && { name: record.error.name, message: record.error.message, stack: record.error.stack } });
  return record;
}

function observeChild(child, label) {
  const events = [], frames = [], writes = [];
  const waiters = new Set(), exitListeners = new Set();
  const decoder = new StringDecoder("utf8");
  let remainder = "", responseTerminal, exitOutcome, closeOutcome, spawnError;
  let resolveExit, resolveClose;
  const exit = new Promise((resolve) => { resolveExit = resolve; });
  const close = new Promise((resolve) => { resolveClose = resolve; });
  function finishResponses(outcome) {
    responseTerminal ??= outcome;
    for (const resolve of waiters) resolve(responseTerminal);
    waiters.clear();
  }
  function frame(line) {
    let value;
    try { value = JSON.parse(line); } catch { value = undefined; }
    const outcome = { kind: value === undefined ? "malformed-frame" : "frame", frame: value, line };
    frames.push(outcome);
    for (const resolve of waiters) resolve(outcome);
    waiters.clear();
  }
  child.stdout?.on("data", (chunk) => {
    events.push({ type: "stdout-data", bytes: chunk.length });
    remainder += decoder.write(chunk);
    const lines = remainder.split(/\r?\n/);
    remainder = lines.pop();
    for (const line of lines) if (line) frame(line);
  });
  child.stdout?.once("end", () => {
    remainder += decoder.end();
    events.push({ type: "stdout-end", remainder });
    finishResponses({ kind: "stdout-eof", remainder });
  });
  for (const name of ["stdin", "stdout", "stderr"]) {
    child[name]?.once("close", () => {
      events.push({ type: `${name}-close` });
      if (name === "stdout") finishResponses({ kind: "stdout-close" });
    });
    child[name]?.once("error", (error) => {
      events.push({ type: `${name}-error`, message: error.message });
      finishResponses({ kind: `${name}-error`, message: error.message });
    });
  }
  child.stdin?.once("finish", () => events.push({ type: "stdin-finish" }));
  child.stderr?.on("data", (chunk) => events.push({ type: "stderr-data", text: chunk.toString() }));
  child.stderr?.once("end", () => events.push({ type: "stderr-end" }));
  child.once("spawn", () => events.push({ type: "child-spawn", pid: child.pid }));
  child.once("error", (error) => {
    // error can also report failed operations after spawn; it is never close.
    spawnError = { kind: child.pid === undefined ? "spawn-error" : "child-error", message: error.message };
    events.push({ type: "child-error", ...spawnError });
    finishResponses(spawnError);
  });
  child.once("exit", (code, signal) => {
    exitOutcome = { kind: "exit", code, signal };
    events.push({ type: "child-exit", code, signal });
    resolveExit(exitOutcome);
    for (const callback of exitListeners) callback(exitOutcome);
    exitListeners.clear();
  });
  child.once("close", (code, signal) => {
    closeOutcome = { kind: "close", code, signal };
    events.push({ type: "child-close", code, signal });
    finishResponses(closeOutcome);
    // Failed spawn has no exit event. This is an explicit absent-exit outcome,
    // not an invented exit; the actual close event is retained independently.
    if (!exitOutcome) resolveExit({ kind: "no-exit-event", spawnError });
    resolveClose(closeOutcome);
  });
  const originalWrite = child.stdin?.write;
  if (originalWrite) child.stdin.write = function observedWrite(...args) {
    const callback = typeof args.at(-1) === "function" ? args.pop() : undefined;
    let resolve;
    const write = { id: writes.length + 1, callbacks: 0,
      completion: new Promise((done) => { resolve = done; }) };
    writes.push(write);
    args.push((error) => {
      write.callbacks += 1;
      write.error = error?.message;
      events.push({ type: "write-callback", id: write.id, error: error?.message });
      if (error) finishResponses({ kind: "write-callback-error", message: error.message });
      // Preserve the product callback and its error argument exactly once.
      try { callback?.(error); } finally { resolve({ kind: "callback", error: error?.message }); }
    });
    try { return originalWrite.apply(this, args); }
    catch (error) { write.thrown = error.message; resolve({ kind: "write-throw", message: error.message }); throw error; }
  };
  return {
    child, label, events, frames, writes, exit, close, terminal: close,
    nextFrame() { return responseTerminal ? Promise.resolve(responseTerminal) : new Promise((resolve) => waiters.add(resolve)); },
    onExit(callback) { if (exitOutcome) callback(exitOutcome); else if (!closeOutcome) exitListeners.add(callback); },
    terminalObserved() { return closeOutcome !== undefined; },
    async written() {
      // The finite protocol has submitted all its requests before this barrier.
      return Promise.all(writes.map((write) => Promise.race([write.completion, close.then(() => ({ kind: "closed-before-callback" }))])));
    },
    snapshot() { return { label, pid: child.pid, events: [...events], frames: [...frames],
      writes: writes.map(({ id, callbacks, error, thrown }) => ({ id, callbacks, error, thrown })),
      exitOutcome, spawnError, terminalOutcome: closeOutcome }; },
  };
}

async function closeServiceNaturally(service, samplers, recovery) {
  const publicClose = trackPromise(() => service.close());
  // closeInternal performs its synchronous work before close() returns. If it
  // has not ended the retained sampler input at this causal boundary, waiting
  // for a native write callback or close first can deadlock the fixture on the
  // exact lifecycle failure under test. End only the retained sampler input,
  // record that public recovery failed, and let the sampler close naturally.
  for (const sampler of samplers) {
    if (!sampler.terminalObserved() && !sampler.child.stdin.writableEnded && !sampler.child.stdin.destroyed) {
      recovery.safetyFallbackRequired = true;
      sampler.child.stdin.end();
    }
  }
  recovery.writeOutcomes = await Promise.all(samplers.map((sampler) => sampler.written()));
  recovery.samplerTerminals = await Promise.all(samplers.map((sampler) => sampler.close));
  // Keep both the precise terminal-boundary observation and the current
  // outcome. An async product continuation may still be queued here. Never
  // freeze that scheduling instant into a claim of permanent product failure.
  recovery.publicCloseAtNativeClose = publicClose.snapshot();
  Object.defineProperties(recovery, {
    publicClose: { enumerable: true, get: () => publicClose.snapshot() },
    publicCloseError: { enumerable: true, get: () => publicClose.error?.message },
    status: { enumerable: true, get: () => publicClose.status === "fulfilled" && !recovery.safetyFallbackRequired ? "recovered" : "failed-recovery" },
  });
  recovery.samplers = samplers.map((sampler) => sampler.snapshot());
  return recovery;
}

module.exports = { observeChild, trackPromise, closeServiceNaturally };
