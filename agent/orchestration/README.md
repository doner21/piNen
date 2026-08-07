# Orchestration Specialist Registry

This directory defines the richer orchestration sidecar layer for Pi orchestration runs.

Primary invariant: **the deterministic `/orchestrate` system (`pi-orchestrator-extension`) is the primary spine**. Specialist `orch-*` agents are optional sidecars selected by task needs.

> NenFlow v3 and its `pev-*` PEV spine were retired 2026-07-18. See `agent/docs/nenflow-v3-retirement.md`.

For any run that mutates files under preservation constraints, start contracts from
`templates/DISCOVERY_FIRST_RUN_CONTRACT.md` (predict-then-write; see `agent/AGENTS.md`
*Discovery before mutation*).

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
2. Never let sidecars replace canonical deterministic-run artifacts unless the user explicitly requests a different flow.
3. Use implementation agents only for bounded file mutations.
4. Use witness/observer agents for evidence and drift, not correctness verdicts.
5. In orchestration run directories, sidecar artifacts should be named `ATT_SIDE_<PHASE>_<AGENT>.md`.

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
