# Verifier Checklist — Win Lifecycle Process Trace

**Status:** HARNESS ARTIFACT — non-invasive diagnostic tooling. For verifier role use during a future human-approved run.

**Verifier Role:** Independently determine PASS or FAIL using direct evidence. Do not rely on the executor's narrative alone. Every conclusion must cite specific evidence fields.

---

## Verifier Directive

> Verifier must **FAIL CLOSED** if any fail condition below is met.
> Verifier must **NOT SKIP** any check.
> Verifier must **CITE SPECIFIC EVIDENCE** (file, line, field) for every conclusion.
> Verifier must **DISTINGUISH** observed evidence from inferred relationships and HYPOTHESIS.

---

## Part A: Harness Integrity (Pre-Run)

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| A1 | Harness was run with explicit human approval | Human verbally or in-writing approved the run; approval is recorded in the run log or operator_note | Human record |
| A2 | No live monitoring until human approves | Harness files exist; no `markers.jsonl` or `process-events.jsonl` older than 1 minute before approval timestamp | Filesystem timestamps |
| A3 | No Pi source code modified | `git status --short` in Pi source repo shows no changes, or `Get-FileHash` comparison of Pi source files unchanged | Git / filesystem |
| A4 | No Windows registry modified | Screenshot or `Get-ItemProperty` diff of relevant registry keys shows no changes | Registry diff |
| A5 | No system services configured | `Get-Service *pi*` shows no new services | PowerShell |
| A6 | No persistent scheduled tasks | `Get-ScheduledTask *pi*` shows no new tasks | PowerShell |
| A7 | No driver installation | `Get-WindowsDriver -Online` diff shows no new drivers | PowerShell |
| A8 | Default WMI-only capture (no ETW/ProcMon without approval) | If `capture_source` field in process-events.jsonl is ever not "wmi-process-start-trace", human explicitly approved ETW/ProcMon | process-events.jsonl |
| A9 | Run directory exists at `%TEMP%\pi-lifecycle-trace\<run_id>\` or specified path | Directory exists and contains expected files | Filesystem |

---

## Part B: Marker Validation (Per-Lifecycle-Path)

### B1: Cold Start Markers

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| B1.1 | `COLD_START_BEGIN` present | Marker found with `label: "COLD_START_BEGIN"`, `lifecycle: "cold_start"` | markers.jsonl |
| B1.2 | `COLD_START_FIRST_RENDER` present | Marker found with `label: "COLD_START_FIRST_RENDER"` | markers.jsonl |
| B1.3 | `COLD_START_END` present | Marker found with `label: "COLD_START_END"` | markers.jsonl |
| B1.4 | Markers in correct monotonic order | B1.1 timestamp < B1.2 timestamp < B1.3 timestamp | markers.jsonl |
| B1.5 | Timestamps are valid ISO-8601 UTC | All three markers have parseable `timestamp_utc` fields | markers.jsonl |
| B1.6 | All markers share same `run_id` | `run_id` matches the run identifier | markers.jsonl |
| B1.7 | No duplicate marker labels | Each label appears exactly once in cold_start lifecycle | markers.jsonl |

### B2: Open-from-Terminal Markers

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| B2.1 | `OPEN_FROM_TERMINAL_BEGIN` present | Marker found with `label: "OPEN_FROM_TERMINAL_BEGIN"` | markers.jsonl |
| B2.2 | `OPEN_FROM_TERMINAL_COMMAND_SENT` present | Marker found with `label: "OPEN_FROM_TERMINAL_COMMAND_SENT"` | markers.jsonl |
| B2.3 | `OPEN_FROM_TERMINAL_ATTACHED` present | Marker found with `label: "OPEN_FROM_TERMINAL_ATTACHED"` | markers.jsonl |
| B2.4 | `OPEN_FROM_TERMINAL_END` present | Marker found with `label: "OPEN_FROM_TERMINAL_END"` | markers.jsonl |
| B2.5 | Markers in correct monotonic order | B2.1 < B2.2 < B2.3 < B2.4 | markers.jsonl |
| B2.6 | Shell PID metadata present | At least one marker has `metadata.shell_pid` set (or operator_note explains why absent) | markers.jsonl |
| B2.7 | Shell kind metadata valid | `metadata.shell_kind` is one of: `cmd`, `powershell`, `pwsh`, `windows-terminal` | markers.jsonl |

### B3: Reload Markers

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| B3.1 | `RELOAD_BEGIN` present | Marker found with `label: "RELOAD_BEGIN"` | markers.jsonl |
| B3.2 | `RELOAD_TRIGGER_SENT` present | Marker found with `label: "RELOAD_TRIGGER_SENT"` | markers.jsonl |
| B3.3 | `RELOAD_POST_IDLE` present | Marker found with `label: "RELOAD_POST_IDLE"` | markers.jsonl |
| B3.4 | `RELOAD_END` present | Marker found with `label: "RELOAD_END"` | markers.jsonl |
| B3.5 | Markers in correct monotonic order | B3.1 < B3.2 < B3.3 < B3.4 | markers.jsonl |
| B3.6 | Pi PID noted (before/after) | At least one RELOAD marker has `metadata.pi_pid` set, or operator_note includes PID | markers.jsonl |

### B4: New Session Markers

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| B4.1 | `NEW_SESSION_BEGIN` present | Marker found with `label: "NEW_SESSION_BEGIN"` | markers.jsonl |
| B4.2 | `NEW_SESSION_TRIGGER_SENT` present | Marker found with `label: "NEW_SESSION_TRIGGER_SENT"` | markers.jsonl |
| B4.3 | `NEW_SESSION_RENDER` present | Marker found with `label: "NEW_SESSION_RENDER"` | markers.jsonl |
| B4.4 | `NEW_SESSION_END` present | Marker found with `label: "NEW_SESSION_END"` | markers.jsonl |
| B4.5 | Markers in correct monotonic order | B4.1 < B4.2 < B4.3 < B4.4 | markers.jsonl |

---

## Part C: Process Event Validation (Cross-Cutting)

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| C1 | Every process event has `timestamp_utc` | All records in process-events.jsonl have valid, parseable `timestamp_utc` | process-events.jsonl |
| C2 | Every process event has `child_pid` | `child_pid` is present, non-null, and > 0 | process-events.jsonl |
| C3 | Every process event has `parent_pid` | `parent_pid` is present | process-events.jsonl |
| C4 | Every process event has `capture_source` | `capture_source: "wmi-process-start-trace"` (or approved alternative) | process-events.jsonl |
| C5 | `raw_event` preserved | Every record has `raw_event` with `TIME_CREATED`, `ProcessID`, `ProcessName`, `ParentProcessID`, `SessionID` | process-events.jsonl |
| C6 | `shell_indicators` populated | Every record has `shell_indicators` with `is_shell_process`, `has_terminal_ancestor`, `has_conhost_nearby` | process-events.jsonl |
| C7 | `enrichment_status` valid | Value is `complete`, `partial`, or `missed-process-exited` | process-events.jsonl |
| C8 | No events timestamped before `COLLECTION_START` | Verify all event timestamps >= COLLECTION_START timestamp (minus clock skew tolerance of 2s) | markers.jsonl + process-events.jsonl |
| C9 | No events timestamped after `TRACE_STOPPED` | Verify all event timestamps <= TRACE_STOPPED timestamp (plus clock skew tolerance of 2s) | markers.jsonl + process-events.jsonl |

---

## Part D: Correlation Window Checks

### D1: Cold Start Window

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| D1.1 | Primary bracket exists | `COLD_START_BEGIN` and `COLD_START_FIRST_RENDER` markers exist | markers.jsonl |
| D1.2 | Core window has events OR documented absence | At least 1 process event in `COLD_START_BEGIN` → `COLD_START_FIRST_RENDER` window, OR correlation report explains why none observed | process-events.jsonl + correlation-report.md |
| D1.3 | No Pi process appears before `COLD_START_BEGIN - 2s` | If a `pi.exe` or `node.exe` process appears in the expanded window before `COLD_START_BEGIN - 2s`, FAIL | process-events.jsonl |
| D1.4 | Pi process appears in expanded window | At least one process matching Pi executable name appears in the expanded window `COLD_START_BEGIN - 2s` → `COLD_START_END + 5s` | process-events.jsonl |
| D1.5 | Window duration within 60s timeout | Core window duration <= 60s, or timeout_exceeded metadata field is false | correlation-report.json |

### D2: Open-from-Terminal Window

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| D2.1 | Primary bracket exists | `OPEN_FROM_TERMINAL_BEGIN` and `OPEN_FROM_TERMINAL_ATTACHED` markers exist | markers.jsonl |
| D2.2 | Parent shell PID observed in process tree | If `metadata.shell_pid` was provided, at least one process event has `parent_pid` matching the shell PID | process-events.jsonl + markers.jsonl |
| D2.3 | Pi process appears with shell ancestor | If launched from terminal, Pi (or its wrapper) has the shell process in its ancestor chain | process-events.jsonl |
| D2.4 | Window duration within 45s timeout | Core window duration <= 45s | correlation-report.json |

### D3: Reload Window

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| D3.1 | Primary bracket exists | `RELOAD_TRIGGER_SENT` and `RELOAD_POST_IDLE` markers exist | markers.jsonl |
| D3.2 | Events can be tied to Pi process tree | If process events are captured, at least one has a parent that matches the Pi executable or the operator-provided `pi_pid` | process-events.jsonl + markers.jsonl |
| D3.3 | Window duration within 90s timeout | Core window duration <= 90s | correlation-report.json |

### D4: New Session Window

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| D4.1 | Primary bracket exists | `NEW_SESSION_TRIGGER_SENT` and `NEW_SESSION_RENDER` markers exist | markers.jsonl |
| D4.2 | Distinguishable from reload evidence | New session evidence is tied to a separate marker set (NEW_SESSION_*) distinct from RELOAD_* markers | markers.jsonl |
| D4.3 | Window duration within 120s timeout | Core window duration <= 120s | correlation-report.json |

---

## Part E: Evidence Integrity

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| E1 | Evidence files not manually edited post-capture | File hashes recorded at TRACE_STOPPED match current hashes, or provenance notation explains any edits | .trace-state.json or operator attestation |
| E2 | No command-line redaction removed parent/child identity | If redaction was applied, `parent_pid` and `child_pid` remain unredacted; `child_process_name` and `parent_process_name` remain unredacted | process-events.jsonl |
| E3 | Raw event fields preserved | `raw_event.TIME_CREATED`, `raw_event.ProcessID`, `raw_event.ParentProcessID`, `raw_event.ProcessName`, `raw_event.SessionID` all non-null for every event | process-events.jsonl |
| E4 | Correlation report distinguishes observed vs inferred | `correlation-report.md` uses **HYPOTHESIS** or *INFERENCE* labels for non-direct observations | correlation-report.md |
| E5 | Correlation report does NOT claim console flash evidence unless backed by ETW/video | Search `correlation-report.md` for "flash" — must be labeled HYPOTHESIS unless ETW/ProcMon/video is cited | correlation-report.md |

---

## Part F: Rollback / Safety Verification (Post-Run)

| # | Check | Pass Condition | Evidence Source |
|---|-------|---------------|-----------------|
| F1 | `TRACE_STOPPED` marker written | Marker with `label: "TRACE_STOPPED"` exists in markers.jsonl | markers.jsonl |
| F2 | No residual WMI subscriptions | `Get-EventSubscriber` shows no entries matching `Win32_ProcessStartTrace` | Operator verification |
| F3 | No residual background jobs | `Get-Job` shows no jobs matching `ProcessStart` | Operator verification |
| F4 | Evidence files preserved | `markers.jsonl`, `process-events.jsonl`, `trace-collector.log` exist in run directory | Filesystem |
| F5 | State files cleaned | `.trace-state.json` and `.trace-subscriber.txt` do not exist in run directory | Filesystem |
| F6 | No Pi files modified | Same as A3 — re-verify after run | Filesystem / git |
| F7 | No registry changes | Same as A4 — re-verify after run | Registry diff |
| F8 | No new services | Same as A5 — re-verify after run | Get-Service |
| F9 | No new scheduled tasks | Same as A6 — re-verify after run | Get-ScheduledTask |

---

## Part G: Acceptance Criteria per Lifecycle Path

### Cold Start — MUST capture for PASS
- [ ] Process tree rooted at Pi executable during `COLD_START_BEGIN → COLD_START_FIRST_RENDER`
- [ ] OR correlation report documents why no processes observed (e.g., no child spawning)

### Open-from-Terminal — MUST capture for PASS
- [ ] Shell PID → Pi process relationship reflected in process events
- [ ] OR shell PID absent AND operator_note explains why (e.g., shell in separate session)

### Reload — MUST capture for PASS
- [ ] Any process events in `RELOAD_TRIGGER_SENT → RELOAD_POST_IDLE` linked to Pi tree
- [ ] OR correlation report documents reload may be in-process (no child spawning)

### New Session — MUST capture for PASS
- [ ] Evidence distinguishes new-session from reload behavior
- [ ] OR correlation report documents inability to distinguish AND explains why

---

## Part H: Verifier Sign-Off

| Field | Value |
|-------|-------|
| **Verifier name / ID** | |
| **Verification date (UTC)** | |
| **Run ID** | |
| **Final verdict** | ☐ PASS  ☐ FAIL |
| **Fail reasons (if FAIL)** | |
| **Evidence files reviewed** | |
| **Human approved run?** | ☐ Yes  ☐ No |
| **Additional notes** | |

---

## Fail-Closed Trigger Conditions (Auto-FAIL)

If ANY of the following is true, verifier MUST return FAIL without proceeding:

1. ❌ Harness was run without explicit human approval
2. ❌ Report claims live evidence but `process-events.jsonl` is empty or missing
3. ❌ Any `_BEGIN` marker is missing for a claimed lifecycle path
4. ❌ Any `_END` marker is missing for a claimed lifecycle path
5. ❌ Marker timestamps are malformed (unparseable ISO-8601)
6. ❌ Process events lack `timestamp_utc` or `child_pid`
7. ❌ A claimed lifecycle path has zero supporting process events AND no documented explanation
8. ❌ Parent/child relationships are asserted without PID evidence
9. ❌ Pi source/config/registry/services modified during harness run
10. ❌ ETW or ProcMon was used without documented explicit human approval
11. ❌ Evidence files edited manually post-capture without provenance notation
12. ❌ Command-line redaction removed parent/child identity (`parent_pid`, `child_pid`, process names)

---

## Uncertainty Log

The verifier must record any unresolved hypotheses:

| # | Hypothesis | Impact | Resolution |
|---|-----------|--------|------------|
| | Pi executable may be named `pi.exe`, `node.exe`, etc. | Low | Resolve from evidence: check child_process_name / parent_process_name fields |
| | WMI enrichment may miss short-lived process command lines | Medium | Check enrichment_status field per event |
| | Console/window flash not directly observable through WMI | High | Mark as HYPOTHESIS in report; require ETW/video for confirmation |
| | Reload may not spawn replacement process | Medium | Check PID before/after from markers |
| | New-session may reuse same process | Medium | Check PID before/after from markers |
| | Start Menu lineage may route through explorer.exe | Low | Check parent_process_name for explorer.exe |
