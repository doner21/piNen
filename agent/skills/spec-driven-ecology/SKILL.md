---
name: spec-driven-ecology
description: 15-phase ecological spec-driven development intake methodology. Treats a user prompt as an opening perturbation in a development ecology and guides from raw prompt to planning-ready spec through invariants, constraints mapping, affordance analysis, attractor/failure-mode analysis, perturbation tests, and explicit handoff contracts. This skill should be used when users request ecological intake, spec-driven development intake, deep spec work, /spec_driven_ecology, or when the task requires rigorous specification before any implementation. Works standalone and as an alternative NenFlow v3 intake mode.
---

# Spec-Driven Ecological Intake

## Skill Purpose and Core Orientation

This skill implements the full 15-phase ecological spec-driven development intake process. It treats a user prompt as an opening perturbation in a development ecology — not as a complete instruction. The purpose is to move from rough intent to a clear, testable, implementation-ready specification.

### Core Claim

The process moves from:

```
raw prompt
→ clarified intent
→ situated purpose
→ context map
→ invariants
→ constraints
→ affordances
→ attractors and risks
→ representative test conditions
→ success criteria and falsifiers
→ planning-ready spec
```

### Core Principle

The intake succeeds when the next agent can act from the generated spec without needing to guess the human's intent or rely on hidden conversation history. The intake fails when it produces elegant wording but leaves implementation agents without concrete boundaries, evidence requirements, or reality-facing tests.

---

## Operating Modes

The intake runs in three depths. Select the depth at Phase 0 based on the task's risk, reversibility, and complexity.

### Minimal Mode

Use when the task is small, reversible, and low risk.

Ask only five questions:

1. What are you trying to make happen?
2. What must remain true?
3. What context must this work inside?
4. What would count as success or failure?
5. What should the next agent be allowed to do?

### Standard Mode

Use for normal feature work, UI work, agent prompts, repo modifications, documentation systems, or workflow design.

Run all main phases (0-15), but limit questioning to the smallest set of material questions. Include perturbation tests only where risk warrants.

### Deep Mode

Use for complex systems, multi-agent orchestration, architectural changes, data pipelines, business-critical workflows, security-sensitive work, or anything that may cause costly drift.

Run all phases fully, including perturbation tests, representative environment design, and explicit handoff contracts.

---

## Roles

### Human

The human provides: desire, purpose, context, constraints, examples, judgments of importance, approval gates, and corrections to the agent's interpretation. The human does not need to provide perfect technical language.

### Intake Agent

The current Pi agent acts as the Intake Agent. It guides the human from raw prompt to spec-ready clarity. It must:

- Preserve the raw user prompt verbatim
- Identify what is known, inferred, unknown, and speculative
- Ask material clarification questions only
- Avoid premature implementation
- Surface hidden assumptions
- Produce a structured spec
- Prepare handoff artifacts

### Planner

Converts the approved intake spec into a staged plan. Must not violate invariants or invent missing context. In NenFlow v3 mode, this maps to the `pev-planner` subagent.

### Executor

Implements only approved tasks from the plan. Must produce evidence of completion. In NenFlow v3 mode, this maps to the `pev-executor` subagent.

### Verifier

Tests the implementation against success criteria, invariants, and falsifiers. Must distinguish verified claims from unverified claims. The Observer role from the ecological methodology is folded into the Verifier — the Verifier watches for drift, overbuild, brittle reasoning, missing evidence, and attractor collapse alongside standard verification duties. In NenFlow v3 mode, this maps to the `pev-verifier` subagent.

---

## Global Invariants

These invariants apply to every intake.

### 1. No Implementation During Intake
The agent must not begin coding, editing files, refactoring, generating migrations, or changing system state during intake. The intake creates readiness for planning and implementation.

### 2. Preserve the Raw Prompt
The original user prompt must be recorded verbatim before interpretation.

### 3. Separate Facts, Inferences, Assumptions, and Unknowns
Every intake must maintain this distinction:

```
Known:
- Facts explicitly provided by the user or found in source-of-truth materials.

Inferred:
- Reasonable interpretations derived from known facts.

Assumed:
- Working assumptions used temporarily to continue the process.

Unknown:
- Missing information that may affect design, scope, verification, or risk.
```

### 4. Ask Only Material Questions
A question is material if the answer could change: intent, scope, architecture, user experience, implementation path, risk level, verification method, or human approval requirements. Avoid questions that only satisfy curiosity or polish.

### 5. Produce a Durable Handoff
The final intake must be usable by a fresh agent without hidden context.

### 6. Verification Must Be Designed Before Execution
Success criteria and falsifiers must be named before implementation begins.

### 7. Reality Contact Over Coherence
A coherent story is insufficient. The intake must connect the spec to actual constraints, users, files, tools, runtime behaviour, data, or observable outcomes.

---

## Ecological Concepts

### Invariants
Conditions that must remain true across all acceptable solutions.

### Constraints
Factors that shape what actions are possible, easy, hard, risky, or forbidden.

Constraint types: technical, human, organisational, timing, legal or security, tool, repo, design, verification.

### Affordances
Actions the system makes available to the human or agent. Examples: the human can correct the agent's interpretation easily; the Planner can derive tasks from the spec; the Executor can locate source-of-truth files; the Verifier can test against observable evidence.

### Attractors
Patterns the system tends to fall into.

**Good attractors:** small diffs, read before edit, evidence before claims, preserve invariants, ask fewer better questions, verify with real runtime evidence.

**Bad attractors:** jumping straight to code, overbuilding architecture, inventing context, satisfying tests narrowly, producing polished but ungrounded documents, hiding uncertainty, treating chat memory as source of truth.

### Perturbations
Deliberate tests that disturb the system to see whether the spec remains functional. Examples: vague prompt, overloaded prompt, contradictory requirements, missing repo context, fresh-agent handoff, failed test evidence, unexpected runtime behaviour.

### Representative Environment
The real or realistic conditions the final output must work inside. May include real users, real data, real device sizes, real deployment environments, real edge cases, real team workflows, real source-of-truth files.

---

## End-to-End Intake Process

### Phase 0: Session Start

**Action:** Record the raw prompt and identify the likely intake depth.

**Output:**

```markdown
## Raw Prompt
[verbatim user prompt]

## Initial Intake Depth
Minimal / Standard / Deep

## Reason for Intake Depth
[brief explanation]
```

**Depth selection guidance:**
- **Minimal:** Task is small, reversible, low risk, no architectural consequences.
- **Standard:** Normal feature work, UI changes, repo modifications, documentation, workflow design.
- **Deep:** Complex systems, multi-agent orchestration, architectural changes, data pipelines, business-critical or security-sensitive work.

---

### Phase 1: Raw Prompt Capture

**Action:** Write the prompt verbatim before interpreting.

**Output:**

```markdown
## Raw Prompt
[verbatim]

## First Reading
[plain-language interpretation]

## Immediate Unknowns
[list only material unknowns]
```

**Rule:** Do not refine the prompt before preserving it.

---

### Phase 2: Intent Clarification

**Questions (ask only the most relevant):**

- What are you trying to make possible?
- What should change after this work is complete?
- Who is this for?
- What is the most important outcome?
- What problem keeps recurring that this should solve?
- What behaviour should this process encourage?
- What behaviour should this process prevent?

**Output:**

```markdown
## Clarified Intent
[one to three paragraphs]

## Intent Confidence
High / Medium / Low

## Intent Corrections Needed
[questions or points for human correction]
```

---

### Phase 3: Purpose Clarification

**Questions:**

- Why is this worth doing?
- What cost, drift, confusion, or failure does this reduce?
- What new capability does this create?
- What will be easier after this exists?
- What should this protect against?

**Output:**

```markdown
## Purpose
[practical reason for the work]

## Underlying Need
[deeper need beneath the surface request]

## Value Created
[how this improves the system or workflow]
```

---

### Phase 4: Context Mapping

**Questions:**

- What project, repo, product, or workflow is this for?
- What already exists?
- What files, docs, systems, or decisions are source-of-truth?
- Who will use the output?
- What tools are available?
- What tools are unavailable?
- What previous attempts or failures matter?
- What constraints are already settled?

**Output:**

```markdown
## Context Map

### Project
[project name or description]

### Current State
[what exists now]

### Desired Future State
[what should exist after the work]

### Source-of-Truth Materials
- [files, repos, docs, schemas, contracts, tickets]

### Actors
- Human requester:
- Intake Agent:
- Planner:
- Executor:
- Verifier:
- End user:
- Other stakeholders:

### Tools Available
- [tools]

### Tools Unavailable
- [tools]

### Known Limits
- [limits]
```

**Pi tool guidance:** Use `read` to inspect source-of-truth files. Use `bash` to list directory structures, check git history, or verify file existence. Use `ls`, `rg` (ripgrep), and `find` for context mapping. Do not write or edit files during intake.

---

### Phase 5: Epistemic Separation

**Action:** Separate the intake into four categories.

**Output:**

```markdown
## Epistemic Map

### Known
- [explicit facts]

### Inferred
- [interpretations with basis]

### Assumed
- [temporary assumptions]

### Unknown
- [missing information]

### Material Unknowns
- [unknowns that may change scope, risk, architecture, or verification]
```

**Rule:** If an assumption becomes important to implementation, convert it into a question or a human gate.

---

### Phase 6: Invariant Discovery

**Questions:**

- What must never be broken?
- What must always be preserved?
- What would make the result unacceptable?
- What existing behaviour must remain unchanged?
- What decisions are already settled?
- What should future agents not reinterpret?
- What human approval is required before irreversible action?

**Output per invariant:**

```markdown
## Invariants

1. [Invariant]
   - Why it matters:
   - Verification method:

2. [Invariant]
   - Why it matters:
   - Verification method:
```

**Rule:** A strong invariant should be testable or inspectable. Weak: "The output should be good." Strong: "The output must produce a handoff that a fresh agent can use without reading the original conversation."

---

### Phase 7: Constraint Mapping

**Questions:**

- What technical stack must be respected?
- What files or areas should not be touched?
- What existing conventions must be followed?
- What level of complexity is acceptable?
- What deadlines or time constraints exist?
- What security, privacy, or data constraints matter?
- What human workflows must be preserved?
- What tools should the agents use for verification?

**Output:**

```markdown
## Constraints

### Technical Constraints
- [...]

### Design Constraints
- [...]

### Human Constraints
- [...]

### Organisational Constraints
- [...]

### Security and Privacy Constraints
- [...]

### Tooling Constraints
- [...]

### Time and Cost Constraints
- [...]

### Verification Constraints
- [...]
```

---

### Phase 8: Affordance Mapping

**Questions:**

- What should the human be able to do easily?
- What should the agent be able to inspect easily?
- What should the Planner be able to derive easily?
- What should the Executor be able to act on easily?
- What should the Verifier be able to test easily?
- What should be hard, blocked, or require approval?

**Output:**

```markdown
## Affordance Landscape

### For the Human
- [...]

### For the Intake Agent
- [...]

### For the Planner
- [...]

### For the Executor
- [...]

### For the Verifier
- [...]

### Actions That Should Be Difficult or Blocked
- [...]
```

---

### Phase 9: Attractor and Failure-Mode Analysis

**Questions:**

- What does the agent tend to over-assume here?
- Where might it jump too quickly?
- Where might it overbuild?
- Where might it produce plausible but unverified work?
- Where might a human become overloaded or unclear?
- What bad pattern has happened before in similar work?

**Output:**

```markdown
## Attractors and Failure Modes

### Useful Attractors to Strengthen
- [pattern]
- [pattern]

### Bad Attractors to Counter
- [pattern]
- [pattern]

### Counter-Constraints
- [constraint designed to prevent bad attractor]
- [constraint designed to prevent bad attractor]

### Early Warning Signs
- [observable sign of drift]
- [observable sign of overbuild]
- [observable sign of weak verification]
```

---

### Phase 10: Scope and Boundary Setting

**Questions:**

- What is explicitly in scope?
- What is explicitly out of scope?
- What is tempting but should be deferred?
- What decisions belong to this intake?
- What decisions belong to the Planner?
- What decisions require human approval later?

**Output:**

```markdown
## Scope

### In Scope
- [...]

### Out of Scope
- [...]

### Deferred
- [...]

### Requires Human Gate
- [...]
```

---

### Phase 11: Representative Environment Design

**Questions:**

- Where will this actually be used?
- What real users, workflows, data, devices, or edge cases matter?
- What toy example would give false confidence?
- What should be tested in conditions close to real use?
- What examples should be included in the spec?

**Output:**

```markdown
## Representative Environment

### Real Use Context
- [...]

### Realistic Inputs
- [...]

### Realistic Edge Cases
- [...]

### Misleading Toy Conditions to Avoid
- [...]

### Evidence Needed From Real or Representative Use
- [...]
```

---

### Phase 12: Perturbation Tests

**Questions:**

- What if the prompt is vague?
- What if the prompt contains too much context?
- What if requirements conflict?
- What if the repo has undocumented conventions?
- What if the agent has to continue from a fresh context?
- What if tests pass but the visible behaviour is wrong?
- What if implementation reveals that the spec was incomplete?

**Output:**

```markdown
## Perturbation Tests

1. Vague Prompt Test
   - Perturbation:
   - Expected response:
   - Failure condition:

2. Overloaded Prompt Test
   - Perturbation:
   - Expected response:
   - Failure condition:

3. Contradiction Test
   - Perturbation:
   - Expected response:
   - Failure condition:

4. Context Loss Test
   - Perturbation:
   - Expected response:
   - Failure condition:

5. Verification Weakness Test
   - Perturbation:
   - Expected response:
   - Failure condition:

6. Scope Creep Test
   - Perturbation:
   - Expected response:
   - Failure condition:
```

---

### Phase 13: Success Criteria and Falsifiers

**Questions:**

- What would make this clearly successful?
- What evidence would convince you it works?
- What would show that it only looks good?
- What failure would matter most?
- What should the Verifier reject?

**Output:**

```markdown
## Success Criteria

1. [Criterion]
   - Evidence required:
   - Verification method:

2. [Criterion]
   - Evidence required:
   - Verification method:

## Falsifiers

1. [Failure condition]
   - Why it invalidates success:

2. [Failure condition]
   - Why it invalidates success:
```

**Rule:** Every success criterion should be linked to evidence.

---

### Phase 14: Human Gate Before Planning

**Action:** Present a compact approval block before proceeding.

**Output:**

```markdown
## Human Review Gate

### My Current Understanding
[summary]

### Decisions I Believe Are Settled
- [...]

### Decisions Still Open
- [...]

### Assumptions I Am Carrying
- [...]

### Ready for Planning?
Yes / No

### Human Approval
Approved / Revise / Stop
```

**Rule:** If approval is missing and the work is high risk, do not proceed to planning.

---

### Phase 15: Final Intake Spec Synthesis

**Action:** Convert the intake into the final spec format.

**Output:**

```markdown
# Final Intake Spec

## Raw Prompt
[verbatim]

## Clarified Intent
[final intent]

## Purpose
[why this matters]

## Current Context
[what exists now]

## Desired Future State
[what should exist]

## Actors
- Human:
- Intake Agent:
- Planner:
- Executor:
- Verifier:
- End user:

## Known
- [...]

## Inferred
- [...]

## Assumed
- [...]

## Unknown
- [...]

## Invariants
- [...]

## Constraints
- [...]

## Affordances
- [...]

## Attractors to Strengthen
- [...]

## Attractors to Counter
- [...]

## Counter-Constraints
- [...]

## Scope
### In Scope
- [...]

### Out of Scope
- [...]

### Deferred
- [...]

## Representative Environment
- [...]

## Perturbation Tests
- [...]

## Success Criteria
- [...]

## Falsifiers
- [...]

## Human Gates
- [...]

## Planning Readiness
Ready / Not Ready

## Recommended Next Agent
Planner / Researcher / Architect / Human / Verifier

## Handoff Notes
[notes for next agent]
```

---

## Conversation Protocol

The Intake Agent uses this loop during the ecological intake conversation.

### Step 1: Reflect

State the current interpretation:

```markdown
My current reading is:
[interpretation]
```

### Step 2: Separate

Categorize what is known, inferred, and unknown:

```markdown
Known:
- [...]

Inferred:
- [...]

Unknown:
- [...]
```

### Step 3: Ask Material Questions

Ask between one and five questions per pass. Prefer fewer questions if a provisional spec can already be drafted.

### Step 4: Offer a Provisional Structure

Propose the spec structure:

```markdown
A useful structure for this spec would be:
1. intent
2. purpose
3. context
4. invariants
5. constraints
6. affordances
7. risks
8. success criteria
9. handoff
```

### Step 5: Let the Human Correct the Frame

Prompt for corrections before synthesizing:

```markdown
Please correct the intent or constraints before I turn this into a spec.
```

### Step 6: Synthesize

Once enough clarity exists, produce the final intake spec (Phase 15).

---

## Material Question Filter

Before asking any question, test it against this filter. Ask the question only if the answer could change at least one of:

- scope
- architecture
- implementation path
- risk
- verification
- user experience
- data handling
- human approval
- agent handoff
- source-of-truth selection

If the answer would merely make the document more polished, defer it.

---

## LLM First Response Templates

### Full Template (Standard and Deep modes)

When a user gives a raw development prompt, open with:

```markdown
I will treat this as an intake rather than an implementation request.

My current reading is:
[interpretation]

Known:
- [...]

Inferred:
- [...]

Material unknowns:
- [...]

To shape this into a spec, I need the smallest useful clarification:
1. [question]
2. [question]
3. [question]

I will not begin implementation until the intake has produced invariants, constraints, success criteria, and a handoff-ready spec.
```

### Short Template (Minimal mode)

```markdown
My current reading is:
[interpretation]

The key things to clarify are:
1. what must remain true
2. what success looks like
3. what the next agent is allowed to do
```

---

## Intake Readiness Checklist

The intake is ready for planning only when these are true:

```markdown
- [ ] Raw prompt preserved
- [ ] Intent clarified
- [ ] Purpose clarified
- [ ] Context mapped
- [ ] Known, inferred, assumed, and unknown separated
- [ ] Invariants named
- [ ] Constraints named
- [ ] Affordances mapped
- [ ] Attractors and risks identified
- [ ] Scope bounded
- [ ] Representative environment described
- [ ] Perturbation tests included where relevant
- [ ] Success criteria are observable
- [ ] Falsifiers are explicit
- [ ] Human gates are named
- [ ] Planning readiness stated
- [ ] Next agent is identified
```

If any critical item is missing, mark the intake as:

```markdown
Planning Readiness: Not Ready
```

and name the blocking issue.

---

## Spec Quality Tests

Use these tests to evaluate the completed intake.

### Fresh Agent Test
A fresh agent should be able to read the final spec and understand: what is being attempted, why it matters, what must remain true, what is in scope, what is out of scope, what evidence is required, and what the next step is.

**Failure condition:** The fresh agent needs hidden conversation history to continue safely.

### Verification Contact Test
Every success criterion should connect to observable evidence.

**Failure condition:** The spec says the work should be "better", "cleaner", "robust", or "elegant" without defining how that will be checked.

### Scope Stability Test
The spec should prevent accidental expansion.

**Failure condition:** The Executor can reasonably justify touching unrelated systems because boundaries were unclear.

### Invariant Preservation Test
The spec should make non-negotiables visible.

**Failure condition:** A next agent can miss or reinterpret a critical human constraint.

### Representative Use Test
The spec should preserve relevant real-world conditions.

**Failure condition:** The implementation works only on toy examples and fails under realistic use.

---

## Standalone Invocation

### Triggering the Skill

Invoke this skill standalone by typing `/spec_driven_ecology` or saying "use ecological intake" or "run spec-driven ecology intake".

### Standalone Behavior

When invoked standalone (outside NenFlow v3):

1. **Begin Phase 0 immediately.** Record the user's raw prompt verbatim. Identify the appropriate intake depth (Minimal/Standard/Deep) with a brief rationale.
2. **Start the conversation loop.** Use the Conversation Protocol (Reflect → Separate → Ask Material Questions → Offer Provisional Structure → Let Human Correct → Synthesize).
3. **Guide through all phases** appropriate to the selected depth:
   - Minimal: Phases 0, 1, 2, 14, 15 with condensed questioning
   - Standard: All phases with limited questioning
   - Deep: All phases with full questioning, perturbation tests, and explicit handoff contracts
4. **Produce the Final Intake Spec** (Phase 15 output) in the current working directory or at a user-specified path.
5. **Do not implement anything.** The skill produces only the specification. Implementation is the Executor's job after planning.

### Standalone Output

The standalone intake produces:
- A **Final Intake Spec** document containing all ecological sections: Raw Prompt, Clarified Intent, Purpose, Context Map, Epistemic Map, Invariants, Constraints, Affordance Landscape, Attractors and Failure Modes, Scope, Representative Environment, Perturbation Tests, Success Criteria, Falsifiers, Human Gates, Planning Readiness, Recommended Next Agent, Handoff Notes.
- Optionally, **handoff templates** (Planner, Executor, Verifier) can be generated from the references directory.

---

## NenFlow v3 Integration Mode (RETIRED)

> **NenFlow v3 was retired 2026-07-18** (see `agent/docs/nenflow-v3-retirement.md`). This
> integration mode is inactive: do not spawn `pev-intake-ecological` (disabled). Use this
> skill in **standalone mode** — it still produces full intake artifacts (ATT_0_INTAKE.md
> etc.) in the current session — or feed its intake spec into the deterministic
> `/orchestrate` system. The section below is kept for historical reference only.

### Triggering Ecological Mode in NenFlow

Within NenFlow v3, ecological intake mode is triggered when the user's prompt contains keywords like: "ecological", "spec-driven ecology", "ecological intake", "deep spec", "/spec_driven_ecology", or when the user explicitly asks for the 15-phase ecological process.

### Orchestrator Behavior in Ecological Mode

When ecological mode is detected:

1. The Orchestrator does **NOT** perform INTAKE itself.
2. The Orchestrator spawns the `pev-intake-ecological` subagent.
3. The subagent receives: raw prompt, run id, RUN_CONFIG.json path, context_handoff_threshold_percent, exact ATT_0_INTAKE.md output path, and exact continuation path.
4. The subagent uses this `spec-driven-ecology` skill to guide the ecological intake conversation.
5. The subagent produces ATT_0_INTAKE.md in NenFlow-compatible format with the standard frontmatter schema plus enriched ecological sections.

### ATT_0_INTAKE.md Format

The ecological ATT_0_INTAKE.md includes the standard NenFlow INTAKE sections (Task Summary, Task Type, User Intent, Goal Attractor, Constraints, Invariants, Success Criteria, Ambiguities, Routing Decision) plus ecological supplements:

- Epistemic Map (Known/Inferred/Assumed/Unknown)
- Affordance Landscape
- Attractors and Failure Modes
- Perturbation Tests
- Representative Environment
- Falsifiers
- Human Gates

These supplements are additive — the Planner, Executor, and Verifier consume the same format without changes. The ecological sections enrich the specification without breaking compatibility.

### After Ecological Intake

After `pev-intake-ecological` produces ATT_0_INTAKE.md, the Orchestrator:
1. Reads and validates the produced INTAKE
2. Continues to RESEARCH (optional) or PLAN normally
3. Routes D-E (continuation, retry) operate as usual

### Ambiguity Handling

If it is unclear whether the user wants ecological intake mode, the Orchestrator explicitly asks rather than auto-detecting from ambiguous prompts.

---

## Example Micro-Intake

### Raw Prompt

```
Create a prompt for an AI agent that improves our booking dashboard.
```

### Clarified Intent

The user wants an agent-ready process for improving the booking dashboard without creating regressions, losing existing business logic, or relying on vague UI preferences.

### Purpose

Reduce dashboard confusion and make operational booking information easier to inspect and act on.

### Invariants

- Existing confirmed bookings must not be modified.
- Existing room-capacity logic must remain intact.
- The agent must inspect current dashboard code before proposing changes.
- The final result must be verified with realistic booking data.

### Constraints

- Must follow existing repo conventions.
- Must not rewrite the whole dashboard.
- Must produce screenshots or runtime evidence.
- Must preserve mobile usability.

### Affordances

- Human can approve design direction before implementation.
- Planner can split UI, data, and verification tasks.
- Executor can make small diffs.
- Verifier can compare before and after behaviour.

### Bad Attractors

- Overbuilding a new dashboard.
- Inventing booking logic.
- Testing only with fake clean data.
- Treating visual polish as operational improvement.

### Success Criteria

- Dashboard exposes the key booking state more clearly.
- No booking data is altered by the UI changes.
- Mobile and desktop views remain usable.
- Screenshots demonstrate before and after behaviour.

### Falsifiers

- Existing bookings are changed.
- The agent rewrites unrelated systems.
- The UI looks better but hides important operational state.
- No runtime evidence is produced.

### Planning Readiness

Ready for Planner.
