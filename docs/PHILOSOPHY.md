# The piNen Philosophy — Build-First, Orchestration-Ready Intelligence

> **"warm terminal intelligence"**

## Build first; orchestrate when asked

piNen starts from a practical rule: real work and real tests matter more than
process artifacts. In normal **direct mode**, the current agent reads, builds,
fixes, and validates the task itself. A correctly failing check gets repaired;
an obsolete check gets fixed or removed with the change. Completion means an
observed machine result or a substantial artifact the user can run, hear, or
measure.

Complex work sometimes benefits from separate planning, implementation, and
verification contexts. When the user explicitly requests **orchestration
mode**, piNen becomes a coordinator: it selects a bounded shape, delegates to
isolated specialist subagents, passes artifacts between phases, and reports the
verified result. The mode must be described honestly, but it does not require
extra role ledgers, receipts, or policy paperwork beyond what the selected
shape produces.

## Memory that remembers what matters

Most agent systems treat memory as a cache — something to be discarded
when the session ends. piNen treats memory as **layered persistence**,
each layer more durable than the last:

| Layer | Medium | Lifespan | Purpose |
|-------|--------|----------|---------|
| **Session memory** | Context window | One session | Working state |
| **Engram** | Binary database | Across restarts | Decisions, observations, patterns |
| **Graphify Brain** | Knowledge graph | Across projects | Architecture, dependencies, wiki |

Engram remembers *what you learned.* The Graphify Brain remembers
*what the project is.* Together, they mean piNen does not rediscover
the same truths in every session — it carries its understanding forward.

A session that ends without saving to Engram is a session that might
as well not have happened. We save immediately after every meaningful
discovery: a bug fix, an architecture decision, a non-obvious gotcha,
a user preference. We end every session with a structured summary.
This is not optional — it is how piNen grows.

## Shapes as frozen patterns of orchestration

An orchestration shape is a **reusable pattern of delegation** — a
named, deterministic, lifecycle-gated way of moving from task to
result. The built-in shapes are common patterns:

- **plan-execute-verify**: the classic three-act structure
- **multi-verify-vote**: skepticism as methodology — multiple
  independent judges must agree
- **composable-pipeline**: unfold a task through arbitrary phases
- **ssi-single-writer-exclusive-lane**: serialized writing as a safety-critical operation
- **verify-only**: pure judgment, no execution

Each shape is a sibling. They share the substrate — the safety layer
that guarantees bounds on spawns, iterations, and time — but they
never build on each other. A shape does not import, extend, or call
another shape. This is the **sibling rule**, and it prevents
dependency cycles, unbounded recursion, and the kind of emergent
complexity that makes orchestration systems untrustworthy.

### The sibling rule, stated:

> Shapes are siblings — they stand on the substrate, never build on
> each other.

This rule exists because an orchestration system that allows shapes to
compose recursively becomes unpredictable. A shape that calls a shape
that calls a shape creates a tree of unknown depth. The sibling rule
keeps the call graph flat — every shape is one level above the
substrate, and no shape can spawn another shape. The result is a
system that is **deterministic by construction**.

## The shape-builder: the harness that grows itself

The `shape-builder` paradigm is piNen's meta-cognitive capability —
the ability to create new orchestration patterns from a specification
and gate them into usability through a full lifecycle:

```
proposed → implemented_verified → reloaded_discovered → canary_passed
                                          ↓
                                    usable: true
```

This is not a code generator. It is a **lifecycle-gated constructor**
that treats every new shape as a hypothesis to be verified. The
verifier must independently attest that the shape's source, tests,
registry, documentation, and safety constraints are correct before
`implemented_verified` is set. The runtime must prove it can discover
the new shape after reload before `reloaded_discovered` is set. The
shape must execute a canary through the active runtime and pass before
`canary_passed` is set.

Only then does `usable` become true.

This means piNen can **evolve its own orchestration vocabulary** —
adding new paradigms for novel task shapes without manual extension
coding, without breaking the sibling rule, without unbounded recursion,
and without ever marking a shape usable before it has been independently
proven to work in the active runtime.

## Connected intelligence is not optional

An agent that lives only in the terminal cannot respond to the world.
piNen connects:

- **Telegram** — because sometimes you need to send a command from
  your phone. The Telegram bridge is a first-class interface: pair a
  sender, send messages, receive results, route to the active session.
  It runs as a background daemon, always listening.

- **Gmail** — because email is where tasks arrive. Read inbox, send
  responses, search archives. Email-based task intake means the agent
  meets you where you already work.

- **MCP ecosystem** — because the world is more than files.
  Spotify for music while you work. Tavily for internet research when
  you need current information. And an extensible MCP server framework
  for connecting anything else.

The principle: **piNen should be reachable from anywhere you think
about work.**

## Safety as a first-class concept

PiNen's safety model is not bolted on — it is structural:

- **Mode honesty** keeps runs understandable: direct work is reported as direct
  work, while an explicitly requested orchestration is actually delegated
  through the selected shape. No extra ledger is needed to state what happened.

- **Effect-based judgment** distinguishes between what an agent says
  and what it actually did. Text-shape heuristics (truncation signals,
  escape clauses, "text-only" claims) are demoted to warnings; real
  file mutations are the only evidence that counts for implementation
  work.

- **Substrate bounds** are hard caps enforced at the substrate level.
  No shape, no matter what it requests, can spawn more than
  `SUBSTRATE_CAPS.MAX_TOTAL_SPAWNS` subagents or iterate more than
  `SUBSTRATE_CAPS.ABSOLUTE_MAX_ITERATIONS` times.

- **gitleaks scanning** runs before every GitHub publish, catching
  secrets before they reach a remote.

- **Private-first publishing** means no accidental public exposure
  of a repository — every repo starts private.

## The terminal is warm

piNen's tagline — *"warm terminal intelligence"* — carries a deliberate
double meaning. The terminal is warm because the agent cares about the
quality of its work, the integrity of its process, and the persistence
of what it learns. And the terminal is warm because the agent is
connected — to Telegram, to email, to music, to the graph of project
knowledge that grows richer with every session.

This is not cold automation. It is **warm intelligence** — an agent
that delegates because it respects the limits of its own context, that
remembers because forgetting is a waste of what was learned, that
evolves because the shape-builder lets it grow new capabilities, and
that connects because isolation is not intelligence.

---

## Ten principles

1. **Build directly by default.** The current agent owns implementation and
   machine validation unless the user asks for orchestration.

2. **Orchestrate explicitly and honestly.** Intake → plan → delegate → verify
   gives complex tasks a bounded multi-context structure when requested.

3. **Remember across time.** Session memory is ephemeral; Engram and
   the Graphify Brain are not.

4. **Shapes are siblings.** They stand on the substrate. No shape
   builds on another.

5. **The shape-builder lets the harness evolve.** New orchestration
   patterns are verified, reloaded, discovered, and canaried before
   they are usable.

6. **Lifecycles are monotonic.** Progress goes forward. Statuses
   cannot skip or regress.

7. **Connect to where you work.** Telegram, Gmail, MCP — the harness
   meets you where you are.

8. **Trust effects, not claims.** Real file mutations are evidence.
   Text-shape heuristics are warnings.

9. **Fix red checks.** Repair product defects, and fix or remove obsolete
   checks in the same change. Safety-critical ambiguity still fails closed.

10. **The terminal is warm.** This is not cold automation. It is
    intelligence that delegates, remembers, evolves, and connects.
