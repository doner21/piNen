const assert = require("node:assert/strict");

function assertItem3InvocationBudget(accounting, invocationId) {
  assert.ok(accounting, `${invocationId}: missing production telemetryAccounting`);
  assert.ok(accounting.peakCounterBytes <= 16 * 1024, `${invocationId}: counter peak ${accounting.peakCounterBytes}`);
  assert.ok(accounting.peakEventBytes <= 512 * 1024, `${invocationId}: event peak ${accounting.peakEventBytes}`);
  assert.ok(accounting.peakControlBytes <= 64 * 1024, `${invocationId}: control peak ${accounting.peakControlBytes}`);
  assert.ok(accounting.peakTerminalBytes <= 256 * 1024, `${invocationId}: terminal peak ${accounting.peakTerminalBytes}`);
  assert.ok(accounting.peakDiskBytes <= 1024 * 1024, `${invocationId}: aggregate disk peak ${accounting.peakDiskBytes}`);
  assert.ok(accounting.maxQueuedBytes <= 64 * 1024, `${invocationId}: queue peak ${accounting.maxQueuedBytes}`);
  assert.ok(accounting.maxPollBytes <= 256 * 1024, `${invocationId}: poll peak ${accounting.maxPollBytes}`);
  assert.ok(accounting.peakFiles <= 128, `${invocationId}: telemetry file peak ${accounting.peakFiles}`);
  if (accounting.peakReservedBytes !== undefined) {
    assert.ok(accounting.peakReservedBytes <= 1024 * 1024, `${invocationId}: reserved aggregate peak ${accounting.peakReservedBytes}`);
  }
}

function assertItem3ProducerBudget(accounting, invocationId, sharedReadAccounting = {}) {
  assert.ok(accounting, `${invocationId}: missing producer accounting`);
  if (sharedReadAccounting.maxActualBytes !== undefined) {
    assert.ok(Number(sharedReadAccounting.maxActualBytes) <= 256 * 1024,
      `${invocationId}: actual read/delivery peak ${sharedReadAccounting.maxActualBytes}`);
    assert.ok(Number(sharedReadAccounting.maxActualBytes) <= Number(sharedReadAccounting.maxCycleBytes),
      `${invocationId}: actual read/delivery ${sharedReadAccounting.maxActualBytes} exceeded granted credits ${sharedReadAccounting.maxCycleBytes}`);
  }
  assert.ok(Number(accounting.peakEventBytes) <= 512 * 1024, `${invocationId}: event peak ${accounting.peakEventBytes}`);
  assert.ok(Number(accounting.peakControlBytes) <= 64 * 1024, `${invocationId}: control peak ${accounting.peakControlBytes}`);
  assert.ok(Number(accounting.peakTerminalBytes) <= 256 * 1024, `${invocationId}: terminal peak ${accounting.peakTerminalBytes}`);
  assert.ok(Number(accounting.peakDiskBytes) <= 1024 * 1024, `${invocationId}: aggregate disk peak ${accounting.peakDiskBytes}`);
  assert.ok(Number(accounting.peakReservedBytes) <= 1024 * 1024, `${invocationId}: reserved aggregate peak ${accounting.peakReservedBytes}`);
  assert.ok(Number(accounting.peakFiles) <= 128, `${invocationId}: telemetry file peak ${accounting.peakFiles}`);
  assert.ok(Number(sharedReadAccounting.maxCycleBytes) <= 256 * 1024,
    `${invocationId}: shared read/delivery grant peak ${sharedReadAccounting.maxCycleBytes}`);
}

function assertEveryItem3InvocationBudget(details, caseId) {
  assert.ok(details, `${caseId}: missing production result details`);
  const invocations = Array.isArray(details.invocationTelemetry) ? details.invocationTelemetry : [];
  const owner = details.commandOwnerAccounting;
  assert.ok(owner && typeof owner === "object", `${caseId}: missing single command-owner accounting`);
  const readAccounting = {
    maxCycleBytes: 256 * 1024,
    maxActualBytes: Number(owner.maxCombinedActualBytes) || 0,
  };
  assert.ok(Number(owner.maxOutstandingBytes) <= 256 * 1024 - 16 * 1024,
    `${caseId}: command owner exceeded payload capacity ${owner.maxOutstandingBytes}`);
  assert.ok(readAccounting.maxActualBytes <= readAccounting.maxCycleBytes,
    `${caseId}: command owner combined actual work exceeded the shared cycle ${readAccounting.maxActualBytes}`);
  assert.ok(Number(owner.maxQueuedBytes) <= 64 * 1024, `${caseId}: command owner transport queue peak ${owner.maxQueuedBytes}`);
  assert.ok(Number(owner.maxEventQueueBytes) <= 64 * 1024,
    `${caseId}: command owner retained delivery queue peak ${owner.maxEventQueueBytes}`);
  assert.ok(Number(owner.maxCombinedQueueBytes) <= 64 * 1024,
    `${caseId}: command owner retained/native/claimed queue peak ${owner.maxCombinedQueueBytes}`);
  assert.equal(Number(owner.reservedEventQueueBytes), 0, `${caseId}: delivery queue claims were not released`);
  assert.equal(Number(owner.reservedNonTerminalEventQueueBytes), 0, `${caseId}: nonterminal queue claims were not released`);
  assert.equal(Number(owner.activeStages), 0, `${caseId}: staging file allocations were not released`);
  assert.ok(Number(owner.maxRegistrations) <= 200, `${caseId}: command owner registration peak ${owner.maxRegistrations}`);
  assert.ok(Number(owner.currentOutstandingBytes) === 0, `${caseId}: command owner did not finalize outstanding work`);
  for (const accounting of invocations) {
    assertItem3ProducerBudget(accounting, `${caseId}/${String(accounting.invocationId || "unknown-invocation")}`, readAccounting);
  }
  return invocations.length;
}

module.exports = { assertItem3InvocationBudget, assertItem3ProducerBudget, assertEveryItem3InvocationBudget };
