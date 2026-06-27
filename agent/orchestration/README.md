# Orchestration Specialist Registry

This directory defines the richer orchestration sidecar layer for Pi/NenFlow runs.

Primary invariant: **NenFlow keeps the PEV spine** (`pev-researcher`, `pev-planner`, `pev-executor`, `pev-verifier`). Specialist `orch-*` agents are optional sidecars selected by task needs.

## Phase mapping

- Intake: clarify intent, requirements, non-goals, scope.
- Research: inspect codebase, external dependencies, graphify/memory/prior art, risks.
- Plan: architecture, implementation, migration, test, rollback, task splitting.
- Execute: feature, bugfix, refactor, tests, integration, config, docs.
- Verify: acceptance, regression, security, performance, typecheck, UI.
- Observe: witness execution, context health, drift, artifact completeness.
- Postmortem: decisions, handoff, knowledge capture, run archive.

## Routing rules

1. Start with the smallest useful set of agents.
2. Never let sidecars replace canonical NenFlow PEV artifacts unless the user explicitly requests a non-PEV flow.
3. Use implementation agents only for bounded file mutations.
4. Use witness/observer agents for evidence and drift, not correctness verdicts.
5. In NenFlow run directories, sidecar artifacts should be named `ATT_SIDE_<PHASE>_<AGENT>.md`.

## Simple routing presets

### Small bug fix
- `orch-codebase-scout`
- `orch-bugfixer`
- `orch-acceptance-verifier`
- optional `orch-regression-verifier`

### New feature
- `orch-intake-clarifier`
- `orch-codebase-scout`
- `orch-implementation-planner`
- `orch-feature-implementer`
- `orch-test-writer`
- `orch-acceptance-verifier`

### Risky infrastructure/config change
- `orch-risk-researcher`
- `orch-rollback-planner`
- `orch-config-operator`
- `orch-security-verifier`
- `orch-execution-witness`

### Frontend/UI change
- `orch-codebase-scout`
- `orch-feature-implementer`
- `orch-ui-verifier`
- `orch-regression-verifier`

### Post-run memory capture
- `orch-execution-witness`
- `orch-decision-recorder`
- `orch-knowledge-capturer`
- `orch-run-archivist`
