---
name: interactive-diagram-builder
description: Builds clear, self-contained interactive HTML diagrams for explaining systems, workflows, architectures, state machines, timelines, and conceptual maps. Use when users ask for interactive diagrams, explainable visualizations, clickable flowcharts, architecture maps, process explainers, or educational HTML diagrams.
license: Complete terms in LICENSE.txt
---

# Interactive Diagram Builder

Create **interactive explanatory diagrams** as self-contained HTML files for Pi/browser viewing.

This skill is derived from the `algorithmic-art` skill but serves a different purpose:

- `algorithmic-art` prioritizes generative aesthetics and computational beauty.
- `interactive-diagram-builder` prioritizes clarity, explanation, navigation, and learning.

Do not remove or modify the original `algorithmic-art` skill.

## Pi Harness Adaptation

Invoke this global Pi skill with:

```text
/skill:interactive-diagram-builder
```

Use Pi's available tools such as `read`, `write`, `edit`, and `bash`. Save generated HTML, Markdown, JSON, screenshots, or companion files into the current working directory unless the user asks otherwise. Always provide the saved file path.

Resolve bundled resources relative to this skill directory:

- `templates/interactive-diagram.html` — required starting point for HTML diagrams.
- `references/diagram-patterns.md` — diagram selection guide and interaction patterns.

## When to Use This Skill

Use this skill when the user asks to create or improve:

- interactive flow diagrams
- architecture diagrams
- process explainers
- state machine diagrams
- dependency maps
- timeline diagrams
- knowledge graph explainers
- pipeline visualizations
- system maps
- decision trees
- causal loop diagrams
- educational HTML explainers
- clickable diagrams that reveal more detail

Do not use this skill for purely decorative generative art. Use `algorithmic-art` for that.

## Core Principle

Build diagrams that answer:

```text
What are the parts?
How do they connect?
What happens first, next, and last?
What should the viewer click or inspect?
What concept becomes easier after interacting with this?
```

Beauty is welcome, but explanation comes first.

## Output Contract

Produce two deliverables unless the user asks for only one:

1. **A short diagram model / explanation** in Markdown or in the final response.
2. **A single self-contained HTML file** that can be opened directly in a browser.

The HTML file must:

- work without a local server
- include all CSS and JavaScript inline
- use no build step
- avoid external dependencies unless explicitly justified
- include clickable or hoverable explanations
- include controls that help the viewer understand the diagram
- preserve keyboard and mouse usability
- be readable on normal laptop screens

Recommended file names:

```text
interactive-diagram.html
<topic>-interactive-diagram.html
```

## Mandatory First Step

Before creating the HTML, read:

```text
templates/interactive-diagram.html
```

Use it as the starting point. Keep its overall structure unless the user needs a different format. Replace the sample data, labels, details, colors, and interactions with the user's actual subject.

Read `references/diagram-patterns.md` when choosing diagram type or interaction style.

## Workflow

### 1. Understand the System

Identify:

- audience: beginner, technical, executive, stakeholder, learner
- diagram purpose: teach, debug, plan, explain, compare, navigate
- nodes/entities: components, steps, states, actors, documents, concepts
- relationships: calls, sends, depends on, transforms, contains, follows, causes
- sequence: what happens before/after what
- boundaries: what is in scope and out of scope
- uncertainty: what is known vs inferred

If the user asks for a codebase or architecture diagram and graphify artifacts exist, consult `graphify-out/GRAPH_REPORT.md` or `graphify-out/wiki/` before broad manual exploration.

### 2. Choose the Diagram Type

Select one primary structure:

| User need | Recommended diagram |
|---|---|
| Explain a pipeline | Left-to-right flow |
| Explain a system architecture | Layered component map |
| Explain behavior over time | Timeline or sequence diagram |
| Explain allowed transitions | State machine |
| Explain dependencies | Directed graph or grouped dependency map |
| Explain choices | Decision tree |
| Explain feedback | Causal loop diagram |
| Explain clusters/concepts | Knowledge map |

Avoid mixing too many diagram types at once. If needed, add tabs or modes.

### 3. Build a Diagram Model Before Drawing

Create a lightweight model first. Example:

```javascript
const diagramData = {
  title: "Graphify Slash Command Flow",
  subtitle: "How /graphify becomes graph.html, graph.json, and GRAPH_REPORT.md",
  nodes: [
    { id: "user", label: "User", group: "input", x: 80, y: 200, detail: "Types /graphify with optional path and flags." },
    { id: "extension", label: "Pi Extension", group: "routing", x: 320, y: 200, detail: "Routes /graphify to /skill:graphify." }
  ],
  edges: [
    { from: "user", to: "extension", label: "/graphify <args>", type: "flow" }
  ]
};
```

The model should be simple enough to inspect and edit.

### 4. Design Interactions for Explanation

Include interactions that reveal understanding, not gimmicks.

Recommended interactions:

- click node: show detailed explanation panel
- hover edge: highlight relationship and show label
- search/filter: find a component quickly
- step-through: animate or highlight the flow one stage at a time
- reset view: restore default state
- toggle details: simple vs advanced labels
- group legend: explain color coding
- export/copy summary: optional when useful

### 5. Keep Visual Grammar Consistent

Use consistent visual meaning:

- same color = same group/type
- arrow direction = direction of flow or dependency
- dashed edge = inferred/optional/async/ambiguous
- thick edge = high importance or primary path
- muted node = out of scope or inactive
- numbered badge = sequence step

Include a legend when colors or line styles carry meaning.

### 6. Create the HTML Artifact

Start from:

```text
templates/interactive-diagram.html
```

Replace:

- page title
- sidebar intro
- `diagramData`
- node positions and groups
- edge labels
- explanation content
- legend entries
- optional step list

Preserve:

- self-contained structure
- accessible sidebar/details panel
- SVG canvas area
- pan/zoom controls where useful
- search and reset behavior when useful

### 7. Explain the Diagram After Saving

After writing the HTML file, provide:

- file path
- what the viewer can click or control
- what the color groups mean
- what the primary flow is
- any assumptions made

## Quality Bar

A successful interactive diagram should be:

- **Explainable**: a viewer understands more after clicking through it.
- **Accurate**: source-backed when describing real systems.
- **Legible**: labels do not overlap excessively; spacing is intentional.
- **Navigable**: details panel, search, and reset controls work.
- **Self-contained**: opens as a single HTML file.
- **Purposeful**: every interaction supports learning.

## Diagram Writing Rules

- Prefer concrete labels over vague labels.
- Use active relationship labels: `routes to`, `loads`, `extracts`, `clusters`, `exports`.
- Use short visible labels and longer detail panel text.
- Do not overload the canvas with paragraphs.
- Put detail in the sidebar/panel, not on every node.
- Cite source files in detail text when building from a codebase.
- Mark inferred relationships as inferred when they are not explicitly present.

## Implementation Rules

- Use HTML + CSS + SVG + vanilla JavaScript by default.
- Use p5.js only when animation, force layout, particles, or canvas dynamics materially improve explanation.
- Avoid heavy frameworks for single-file diagrams.
- Avoid external CDNs unless explicitly needed.
- Keep all data inline for portability.
- Include keyboard-friendly buttons and readable contrast.
- Test basic behavior by opening or inspecting the file when possible.

## Common Requests and How to Handle Them

### “Make an interactive diagram of this process”

Create a left-to-right or top-to-bottom flow with step-through controls.

### “Explain this architecture visually”

Create grouped layers: UI, command layer, skill layer, tool layer, output layer. Use edges for data/control flow.

### “Make this codebase easier to understand”

Use graphify artifacts if available. Otherwise inspect README, main entry points, and source directories. Create a component map with clickable details and source file references.

### “Make a diagram from this markdown/spec”

Parse the spec into actors, steps, decisions, and outputs. Use a process or decision-tree layout.

### “Make it beautiful”

Improve typography, spacing, palette, shadows, and motion while preserving explanatory clarity. Do not sacrifice legibility for ornament.

## Suggested Response Format

After creating the file, respond like:

```text
Created: path/to/interactive-diagram.html

What it shows:
- Primary flow: A -> B -> C
- Groups: orange = inputs, blue = processing, green = outputs
- Interactions: click nodes for details, use Step Through to follow sequence, search to find components

Assumptions:
- ...
```

## Resources

- `templates/interactive-diagram.html`: required HTML/SVG starting point.
- `references/diagram-patterns.md`: diagram type and interaction guide.
