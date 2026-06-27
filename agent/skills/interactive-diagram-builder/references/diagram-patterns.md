# Interactive Diagram Patterns

Use this reference to choose a diagram type and interaction model.

## Flow / Pipeline Diagram

Best for:

- command execution flows
- data processing pipelines
- build/deploy steps
- user journeys

Structure:

```text
Input -> Router -> Processor -> Analyzer -> Outputs
```

Interactions:

- step-through buttons
- click a step for detail
- highlight primary path
- show optional branches as dashed arrows

Use when the main question is: **What happens next?**

## Layered Architecture Map

Best for:

- software architecture
- harness/platform internals
- frontend/backend/service diagrams
- package/module relationships

Structure:

```text
User/UI Layer
Command/API Layer
Workflow/Skill Layer
Tool/Service Layer
Storage/Output Layer
```

Interactions:

- click component for responsibility
- toggle layer visibility
- highlight dependencies from selected component
- include source file references in detail text

Use when the main question is: **What part owns what responsibility?**

## State Machine

Best for:

- lifecycle diagrams
- session states
- workflow status
- retry/error handling

Structure:

```text
Idle -> Running -> Waiting -> Complete
             |          |
             v          v
           Error ----> Retry
```

Interactions:

- click state for entry/exit conditions
- hover transition for trigger
- step through example scenario
- distinguish terminal states

Use when the main question is: **What states are possible, and how do transitions happen?**

## Sequence Diagram

Best for:

- request/response flows
- multiple actors over time
- tool orchestration
- protocol explanations

Structure:

```text
Actor A      Actor B      Actor C
  | request -> |            |
  |            | process -> |
  | <- result  | <- output  |
```

Interactions:

- step through messages
- click message for payload/detail
- collapse internal-only messages

Use when the main question is: **Who talks to whom, in what order?**

## Knowledge Map / Concept Map

Best for:

- conceptual systems
- research summaries
- graphify outputs
- documentation maps

Structure:

```text
Central concept connected to related concepts, grouped by color/community.
```

Interactions:

- click concept for explanation
- search concepts
- highlight neighbors
- filter groups

Use when the main question is: **How are these ideas connected?**

## Decision Tree

Best for:

- troubleshooting guides
- product choices
- if/then business logic
- setup paths

Structure:

```text
Question -> Option A -> Outcome A
         -> Option B -> Follow-up question -> Outcome B
```

Interactions:

- click path choices
- show current path summary
- reset decision path

Use when the main question is: **Which path should I take?**

## Timeline

Best for:

- roadmap
- incident narrative
- release history
- project phases

Structure:

```text
Time 1 -> Time 2 -> Time 3 -> Time 4
```

Interactions:

- click event for detail
- filter by actor/category
- zoom levels: summary vs detailed

Use when the main question is: **How did this evolve over time?**

## Causal Loop / Feedback Diagram

Best for:

- systems thinking
- business dynamics
- memory/learning loops
- reinforcing vs balancing effects

Structure:

```text
A increases B, B decreases C, C increases/decreases A
```

Interactions:

- distinguish positive/negative influence
- click loop for explanation
- animate signal around loop

Use when the main question is: **What influences what, and where are the feedback loops?**

## Visual Grammar Recommendations

### Colors

Use colors to represent groups, not random decoration.

Recommended defaults:

- orange: user/input/action
- blue: processing/agent/logic
- green: outputs/success/storage
- purple: optional/extension/integration
- gray: external system or out-of-scope
- red: error/risk/security boundary

### Lines

- solid arrow: direct or primary relationship
- dashed arrow: optional, inferred, async, or conditional relationship
- thick arrow: important path
- muted arrow: secondary path

### Labels

Visible canvas labels should be short. Detail panel text can be longer.

Good visible labels:

```text
Detect Files
Extract Concepts
Build Graph
Cluster Communities
Export HTML
```

Avoid visible labels like:

```text
This stage performs semantic and structural extraction over all source materials and then merges them into a node-link representation
```

Put that in the detail panel instead.

## Interaction Checklist

Include at least three of these:

- click node for detail
- hover edge for relationship label
- search nodes
- step through flow
- reset view
- legend
- show/hide advanced details
- pan/zoom or fit-to-view
- copy/export text summary

## Accessibility Checklist

- maintain readable contrast
- avoid color-only meaning; include labels or legend
- use large enough text
- make controls buttons, not only gestures
- keep detail text selectable
- support browser zoom

## Source-Backed Diagrams

When diagramming a real codebase or project:

- cite source files in node details
- distinguish extracted facts from inferred relationships
- avoid inventing dependencies
- include assumptions in the final response
- prefer graphify reports and wiki artifacts when available
