# Markdown Type Foundry

A visible virtual keyboard that makes every AI-generated character travel through an onscreen key before it is durably written to a real Markdown file.

## What the keyboard can produce

The keyboard exposes the complete printable US-ASCII set plus Enter and Tab:

- headings: `#`
- emphasis: `*` and `_`
- unordered and ordered lists: `-`, `+`, `*`, digits, and `.`
- task lists: `[ ]` and `[x]`
- links and images: `[text](url)` and `![alt](url)`
- blockquotes: `>`
- inline and fenced code: `` ` `` and `~`
- tables: `|`, `-`, and `:`
- escapes: `\`
- HTML and autolinks: `<`, `>`, `/`, `=`, quotes
- headings and document structure through Enter/newlines
- every other printable ASCII punctuation mark

This is enough to express CommonMark and common GitHub-flavored Markdown syntax. Unicode content is intentionally outside the current physical keyboard layer.

### Active rotating-letter constraint

One random ASCII letter disappears at a time. Every five seconds the authoritative server atomically releases the previous letter and blocks a newly sampled, different letter in both cases. The keyboard remains geometrically stable: the missing key is visibly marked in red, its countdown and rotation number appear in the header, and a physical click on it produces an HTTP 409 `CHARACTER_UNAVAILABLE` event instead of a file mutation.

Each run resets to a fresh random sequence and run ID. The sequence, physical attempts, rejected clicks, corrections, and final letter distribution produce a run-specific JSON record and SVG graph under `output/rotating-runs/`.

## Editing controls

The editor maintains a server-side cursor, selection anchor, preferred vertical column, and bounded Undo/Redo history. The visible editing deck provides:

- Left, Right, Up, and Down
- word-left and word-right movement
- Home, End, document start, and document end
- Page Up and Page Down
- Backspace, forward Delete, previous-word deletion, and next-word deletion
- Shift-selection for character, word, line, vertical, and document movement
- Select All and Deselect
- Undo and Redo
- cursor line, column, absolute position, and selected-character count

Insertion replaces the current selection. Navigation changes cursor state without rewriting the file. Content edits remain atomic and durable.

The physical queue accepts both streamed strings and semantic command objects:

```json
{"command":"WORD_LEFT","count":2}
{"command":"SELECT_WORD_RIGHT"}
"replacement text"
{"command":"UNDO"}
```

Supported commands include `LEFT`, `RIGHT`, `UP`, `DOWN`, `HOME`, `END`, `DOC_HOME`, `DOC_END`, `PAGE_UP`, `PAGE_DOWN`, `WORD_LEFT`, `WORD_RIGHT`, `BACKSPACE`, `DELETE`, `BACKSPACE_WORD`, `DELETE_WORD`, `SELECT_LEFT`, `SELECT_RIGHT`, `SELECT_UP`, `SELECT_DOWN`, `SELECT_HOME`, `SELECT_END`, `SELECT_WORD_LEFT`, `SELECT_WORD_RIGHT`, `SELECT_DOC_HOME`, `SELECT_DOC_END`, `SELECT_ALL`, `DESELECT`, `UNDO`, and `REDO`.

## Integrity model

```text
Pi SDK text_delta
  -> one-character JSONL action queue
  -> Win32 desktop pointer
  -> visible key click
  -> localhost /api/edit
  -> accepted/rejected physical acknowledgement
  -> atomic file replacement + fsync for accepted characters only
  -> model warning and physical fragment repair after rejection
  -> UI reload from authoritative file
```

The model output is not copied directly into the file. Only successful virtual-key click handlers may invoke `/api/edit`. The server binds to localhost, accepts no arbitrary path from browser requests, validates every character, and returns the authoritative file content and SHA-256 after each write.

Model deltas can arrive faster than physical clicking. They enter an ordered in-memory queue, but each character is admitted only after the pointer click receives an authoritative acknowledgement. A rejected letter aborts the unadmitted suffix, warns the same model, physically selects and removes the interrupted word fragment, and resumes from the exact persisted document.

## Start the keyboard

```powershell
& "$HOME\.pi\agent\extensions\markdown-keyboard\start_markdown_keyboard.ps1" `
  -File "$HOME\Documents\notes.md"
```

The launcher starts the localhost write server and opens Edge in a fixed-position app window required by the physical pointer map. During a physical typing or editing session, the worker locates the window by title, restores its calibrated geometry, temporarily keeps it topmost so another app cannot intercept clicks, and releases topmost state when the queue stops.

## Run the rotating-letter experiment

```powershell
& "$HOME\.pi\agent\extensions\markdown-keyboard\stream_markdown_with_rotating_constraint.ps1" `
  -PhysicalClear `
  -Speed Maximum `
  -Prompt "Write a Markdown expose of 140 to 170 words about AI world models, tool use, generative friction, affordances, and behavioral orientation."
```

`-PhysicalClear` uses visible **Select All** and **Backspace** clicks; it never invokes a direct clear operation on the authored Markdown. Speed presets are:

- `Visible`: 32/8/30 ms move/press/pause
- `Fast`: 8/3/4 ms
- `Maximum` (default): 0/1/0 ms, still using real pointer down/up actions and per-character server acknowledgements

At a missing key the run:

1. physically clicks the currently missing key,
2. receives an authoritative rejection with letter, run ID, and rotation index,
3. discards the unadmitted model suffix,
4. warns the same model about that physical failure,
5. physically selects and removes the interrupted word fragment,
6. resumes from the exact persisted document.

The completed run writes:

- `rotating-constraint-events.jsonl` — full action/correction stream
- `output/rotating-letter-statistics.json` — latest machine-readable profile
- `output/rotating-letter-statistics.svg` — latest three-panel graph
- `output/rotating-runs/<run-id>.md`, `.json`, and `.svg` — immutable per-run document/profile bundles

Defaults: `openai-codex/gpt-5.6-sol`, `http://127.0.0.1:8766`, 140–170 words, and at most 80 physical corrections. `MARKDOWN_KEYBOARD_PROVIDER`, `MARKDOWN_KEYBOARD_MODEL`, `MARKDOWN_MIN_WORDS`, `MARKDOWN_MAX_WORDS`, and `MARKDOWN_MAX_CORRECTIONS` override those values.

The older fixed-letter scripts remain historical experiment fixtures; the rotating wrapper is the supported live path.

## Direct server use

```powershell
python "$HOME\.pi\agent\extensions\markdown-keyboard\markdown_keyboard_server.py" `
  --port 8766 `
  --file "$HOME\Documents\notes.md"
```

Read/control API:

- `GET /api/document`
- `GET /api/constraint/history`
- `POST /api/constraint/reset` with `{}`

The production store rejects ordinary direct `/api/edit` calls with `403 PHYSICAL_EVENT_REQUIRED`. The page submits edits only from browser events whose `isTrusted` flag is true; synthetic DOM clicks are refused. The localhost edit endpoint remains directly exercisable only by test stores created with `physical_only=False`, so lower-level persistence and rejection behavior can be tested without weakening the running authoring surface.

## Validation

```powershell
python "$HOME\.pi\agent\extensions\markdown-keyboard\test_markdown_keyboard.py"
node --check "$HOME\.pi\agent\extensions\markdown-keyboard\stream_model_to_markdown_keyboard.mjs"
```

The 13-test automated suite covers all printable ASCII mappings, deterministic five-second release/reblock behavior, rejected-attempt metadata, command mapping, selection replacement, punctuation-aware word deletion, vertical preferred-column movement, Undo/Redo, and HTTP persistence.

The first completed rotating run used the AI-world-model prompt at `Maximum` speed. Across 53 random five-second rotations it made 1,196 physical key attempts, admitted 1,174, rejected and repaired 22, and produced a coherent 153-word / 1,107-character Markdown document with exact file SHA-256 `4c34f17f963cc893197329884fb36491394dc3c724de5a68e7c3042caf61b0b3`. Run ID: `41a14070721e4ad08f3c16b6219aebed`.

The fully hardened replay, run `05ded76e28964487b72e28da3e598e9b`, passed the complete wrapper and exact server-attempt reconciliation: 44 rotations, 1,198 physical key attempts, 38 physical edit commands, 1,278 acknowledged/authoritative operations, 22 rejected clicks, and a 161-word / 1,115-character document. The worker executed 1,365 visible clicks in 33.377 seconds (26.96 ms mean, 36 ms p95, zero retries). Document SHA-256: `f28bd79d0f2f7af84e9b64601c3da74a04668a44980d911116d34f2fa1cf3816`; graph SHA-256: `865f9c5605581f68a6b07aa959077cc40a9b8ddfbe5039e3615a82d8ab3327e5`.
