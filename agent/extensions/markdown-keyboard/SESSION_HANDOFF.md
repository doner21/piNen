# Markdown Type Foundry — New-Session Handoff

Date: 2026-08-17

> **Current-state update:** The fixed missing-S configuration described below is now historical. The active app uses one randomly selected missing letter, releases and replaces it every five seconds, acknowledges every physical click, warns the model after a rejected click, physically removes interrupted fragments, and emits immutable per-run Markdown/JSON/SVG bundles. Fully hardened maximum-speed run `05ded76e28964487b72e28da3e598e9b` passed end to end: 44 rotations, 1,198 key attempts, 38 physical edit commands, exact reconciliation of all 1,278 server operations, 22 rejected/repaired clicks, 161 words, document SHA-256 `f28bd79d0f2f7af84e9b64601c3da74a04668a44980d911116d34f2fa1cf3816`. See `README.md` and `output/rotating-letter-statistics.json`.

## Current purpose

The project explores how forcing AI output through a visible, physically clicked keyboard changes generation. The keyboard is not merely a display: it creates a constrained action space, externalizes commitments to a real Markdown file, and turns missing capabilities into observable feedback and repair.

## Durable architecture

Root: `C:/Users/you/.pi/agent/extensions/markdown-keyboard/`

- `markdown-keyboard.html` — visible full-ASCII Markdown keyboard, editing deck, caret/selection/status UI. The S key is currently an inert gap.
- `markdown_keyboard_server.py` — localhost-only authoritative file/cursor/selection/history server; atomic replace + fsync; rejects disabled characters.
- `physical_markdown_typist.py` — Win32 pointer worker; text and semantic edit-command queue; typed HWND APIs; keyboard held topmost during a physical session.
- `keyboard-capabilities.json` — active disabled characters: lowercase and uppercase S.
- `stream_model_to_markdown_keyboard.mjs` — direct Pi SDK text_delta bridge with hard character validation.
- `stream_model_with_live_correction.mjs` — experimental interrupt/warn/physically-correct/resume loop.
- `stream_markdown_with_model.ps1` — standard direct stream wrapper.
- `stream_markdown_with_live_correction.ps1` — live correction wrapper.
- `test_markdown_keyboard.py` — 10 passing tests.
- `live-correction-events.jsonl` — event log from the latest correction experiment (overwritten each run).
- `output/live-markdown-demo.md` — current authoritative document; presently partial because the latest bounded run was interrupted at warning 3 when the owner requested a new session.
- `README.md` — operation and protocol documentation.

## Important successful runs

### Visible physical typing

- Original sentence typed with Shift + 48 character clicks.
- Timing reduced from 44.8 seconds to 4.9 seconds while retaining visible pointer travel and key presses.

### Direct model-token bridge

- Pi SDK `message_update/text_delta` events were forwarded immediately to the physical queue.
- A clean test used 24 deltas; a full Markdown test used 42 deltas/146 characters with exact disk match.
- A 1,599-character AI-world-model essay used 282 deltas and matched the file exactly.
- Mouse speed is slower than model emission, so the physical layer creates ordered backpressure rather than phrase-level precomposition.

### Full Markdown and editing

- Printable US-ASCII plus Enter and Tab covered CommonMark/GFM syntax.
- Added cursor, anchor, visible selection, preferred vertical column, grouped Undo/Redo history, Home/End, document/page movement, word movement, character/word deletion, and Shift selection.
- Physical semantic queue commands include navigation, selection, Undo/Redo, and word deletion.
- A reversible physical edit test changed words, selected by word, exercised Undo/Redo and page movement, then returned a 1,599-character file to its exact prior SHA-256.
- Real edits performed physically:
  - `strains` -> `Constraints`
  - `incompatible objectives` -> `non-negotiable`, preserving punctuation.

### Hard missing-letter lipogram

- S/s removed at four layers: inert visual gap, no physical mapping, server HTTP 400 rejection, and model-stream hard gate.
- Prompt-only compliance failed after 907 valid characters; the bridge correctly blocked the forbidden delta instead of deleting it silently.
- A shorter retry completed: 134 deltas, 655 characters, 104 words, zero S/s.

### First live correction success

- A 140–170-word run began without disclosing the missing key.
- The model attempted `Models`; bridge stopped at `Model`, warned at position 16, same model proposed `Model`, and the physical keyboard selected/retyped the fragment.
- The continuation then avoided further violations and completed at 170 words/1,030 characters with zero S/s.
- A physical two-Enter repair fixed a heading/prose join; final SHA-256 was `f51bedfba51d4d3f5516d066b2f500703becea65447386d25a2f03e3dd3bb92a`.

## Failures and what they taught

### Layout and physicality

1. **Growing output shifted keys**: once text wrapped, fixed coordinates missed. Fix: fixed-height scrolling source pane.
2. **Other windows intercepted clicks**: SSI harness surfaced over the keyboard. Fix: locate HWND, use correctly typed 64-bit SetWindowPos signatures, hold topmost during queue session, release on STOP.
3. **Untyped Win32 signatures silently failed**: SetWindowPos returned ineffective behavior until argtypes/HWND_TOPMOST were explicit.

### State and lifecycle

4. **Stale server processes preserved old code**: multiple background servers caused word-delete behavior to remove punctuation only. Fix: terminate every matching Python server, launch exactly one cache-free process, verify PID and API behavior.
5. **SDK default agentDir crash**: DefaultResourceLoader required explicit agentDir despite docs. Bug note exists under `.pi/bugs that need to be fixed/`.
6. **Global extension stale-context crash**: after 14 SDK session replacements, delayed Git-backup code accessed stale ctx and crashed. Fix/workaround: `noExtensions: true` plus noSkills/noPrompts/noThemes/noContextFiles for isolated stream workers. Bug note: `git-backup-stale-extension-context-after-sdk-session-replacement-2026-08-17.md`.

### Constraint policies

7. **Prompt-only prohibition is unreliable**: longer prose eventually emitted S.
8. **Global warning causes rapid adaptation**: after one failure, same-session continuation avoided every later S. Efficient and coherent, but produced only one observable failure.
9. **Fresh-session local-only warnings fail too often**: English S frequency caused 14 corrections in a very short fragment; prose degraded and extension lifecycle crashed before completion.
10. **Same-session local-only warnings still became pathological**: nine failures occurred in a short fragment and the run timed out after 500 seconds. Corrections such as `i -> it`, `u -> unaided`, and repeated partial-word substitutions damaged coherence.
11. **Correction at character boundary can lose structure**: aborting inside a Markdown heading lost its intended suffix and newline. Fix: continuation prompt explicitly requests punctuation/linefeeds needed for a valid join; physical editing remains the final repair path.
12. **The latest bounded-learning experiment**: policy was changed so the first three failures are local, then repeated evidence becomes a global environmental orientation. The run reached warnings 1–3 (`Model`, `model`, `give`) and was interrupted when the owner requested this new session. Current file is partial and should not be presented as complete.

## Affordances observed

- **Reachability shapes style**: absent punctuation or letters changes the set of possible texts, not just their presentation.
- **Differential cost shapes choices**: every character costs motion/time; capitals require Shift; revision costs navigation and selection. This favors brevity and deliberate commitment.
- **Parataxis and lexical substitution**: punctuation scarcity produces short declarative sentences; missing S produces singular forms, alternate verbs, and unusual but sometimes generative vocabulary.
- **Materialized accountability**: a file, SHA-256, cursor state, and visible clicks make generation inspectable. There is a difference between attempted output, physically admitted output, and final persisted output.
- **Backpressure creates temporal form**: model deltas arrive quickly, but mouse execution paces disclosure and makes hesitation/correction observable.
- **Failure is information**: a rejected key reveals an environmental invariant. How broadly that warning is scoped determines behavior.
- **Local vs global learning is a design parameter**:
  - global warning -> coherent and efficient, little repeated failure;
  - purely local warning -> repeated discovery, high cost, degraded coherence;
  - bounded local failures followed by global consolidation -> promising compromise, not yet completed.
- **Tools externalize commitments**: digital file writes and analog-like pointer travel force internal generation through a resistant medium.
- **Editing changes the ecology**: navigation, selection, deletion, and Undo make repair possible but introduce costs and strategic choices absent from direct text generation.
- **Constraint enforcement must be layered**: visual absence alone is cosmetic; meaningful constraint required UI, physical mapping, server validation, and stream validation.

## Current interrupted state

The latest PowerShell live-correction command was aborted by the owner’s new-session request after warning 3. Check for lingering Node/PowerShell/physical-typist processes before continuing. The authoritative file is partial. Do not call it a completed exposé.

## Recommended next work

1. FIRST read `C:/Users/you/.pi/agent/agent-new-session-diagnostics.json` and verify `phase`, `newSessionConfirmed`, `newSessionSilentlyFailed`, and `executeCommandRejected`.
2. Inspect and terminate only lingering processes whose command lines contain `stream_model_with_live_correction.mjs`, `stream_markdown_with_live_correction.ps1`, or `physical_markdown_typist.py`.
3. Read this handoff, `README.md`, `keyboard-capabilities.json`, current output file, and `live-correction-events.jsonl`.
4. Present the owner with a clear synthesis of successful affordances, severe failures, and lessons learned (the owner explicitly requested this in the new session).
5. Explain the tradeoff curve between global learning, local repeated failure, and bounded escalation.
6. Before another run, physically clear the partial document. Then decide whether to complete the bounded-three-failures experiment or revise its correction semantics (for example, word-buffered correction or a more coherent replacement protocol).
7. Preserve the hard invariant: no direct paste to the `.md`; only visible physical keyboard actions may mutate authored content.
