# Separate Pi windows (Windows)

One shared helper, `window.cjs`, serves the `open_window` tool, `/window`, and the forum router's General `/new`. Nothing here activates a live installation.

## Use

- Ask Pi: “open a new window for a new project called demo-project, and say hello.”
- `/window new demo-project Say hello.`
- `/window open "folder with spaces" Say hello.`
- Telegram **General**: `/new demo-project Say hello.` Existing names open; otherwise valid names create a new project. Quote paths with spaces. Project-topic `/new` is consumed without delivery. Existing pinned group/allowlist checks run before launch effects.

Only the first name/path uses quote syntax. All entrypoints preserve the remaining instruction, including trailing whitespace. In the TUI a narrow `CustomEditor` integration submits `/window` before core input trimming; ordinary input still follows the usual editor and application keybindings. Instruction quotes, shell punctuation, leading options, `@file` and slash-like text are not executed or expanded. The tool accepts `new`, `open`, or `auto` and a separate optional `instruction` field.

A confirmed response names the new session's **own** Telegram topic, not merely a successful `wt.exe` invocation. Its first instruction and the exactly correlated first reply are sent to that topic. Later local conversations, repeated instructions, combined prompts and locally steered answers are not mirrored by launch correlation. Ordinary Telegram ticket-based conversations remain unchanged.

## Local configuration

Copy `config.example.json` to the user's agent directory as **`window.json`**, or select an absolute local file with `PI_WINDOW_CONFIG`. The empty example uses defaults; never put deployment IDs, credentials or a personal configuration in this source tree.

Optional fields (absolute local paths):

| Field | Default / meaning |
| --- | --- |
| `home` | Current OS user's home |
| `projectsRoot` | `<home>/projects` |
| `runtimeRoot` | Dedicated `pi-window-runtime` under Windows user Temp |
| `piCli` | Current Pi CLI, or conventional user npm installation's `dist/cli.js`; configure for other installations |
| `agentDir` | Usual `PI_CODING_AGENT_DIR`, otherwise `<home>/.pi/agent` |
| `telegramExtension` | `<agentDir>/extensions/telegram-pi/index.ts` |
| `telegramRuntime` | Optional existing topic router runtime; otherwise the Telegram deployment selects it |
| `leanMethod` | `<agentDir>/docs/lean-working-method.md` |

`projectsRoot` must be below `home`. A missing immediate child root is created exclusively; deeper custom roots must already exist. `runtimeRoot` must be a dedicated directory under Windows user Temp, with an existing canonical parent. Startup state/config, including the selected Telegram runtime, cannot overlap an opened folder: overlapping requests refuse before creating a project or writing there. Do not point runtime/config at an existing project.

Normal configured model defaults and catalog are retained; no worker model/provider/thinking or continuation/session flags are supplied. Inherited worker/session metadata is removed. A new process starts in `wt.exe -w new -d <folder> --title <label> --suppressApplicationTitle --inheritEnvironment ...`, without a command shell. The Terminal launch explicitly uses `windowsHide: false`: hiding `wt.exe` can forward hidden startup state to the requested window. Ordinary helper commands remain hidden. Bootstrap composes the installed SDK services/session runtime and the genuine `InteractiveMode` TUI. It does **not** call CLI `main`, whose unconditional migrations and pre-trust settings lookup can mutate an existing project.

The child loads only the configured real Telegram entrypoint and window extension, disables project trust, and explicitly stores a fresh session outside the project. Global settings are read without file locks into a process-local settings manager; project settings are never opened by that manager. Package declarations and configured resource/session paths are removed from this snapshot before the real resource loader runs, preventing auto-install side effects. Other discovered extensions, skills, templates and themes are disabled for startup isolation. Settings changes in this special window are process-local; they do not update global/project settings. Temporary/compiler caches are disabled or external. Automatic catalog/package/version refresh is disabled, but normal authenticated model inference remains enabled. An unavailable configured default model refuses rather than silently using another. This intentionally does not run unrelated schedulers or project extensions. Read-only context discovery remains normal. The launcher is **not an OS sandbox**: later explicit model/tool work retains normal user permissions.

## Filesystem safety

Names allow only ASCII letters/numbers/hyphens (1–80 characters), excluding Windows reserved devices. Existing targets resolve beneath configured home, trying projects before home for bare names. Network/device paths, symlinks, junctions and canonical aliases are refused. Paths containing semicolons also refuse before launch: Windows Terminal has its own command-delimiter grammar even without a shell. Instructions containing semicolons remain literal data. Existing projects are never initialized or populated.

A Windows current-directory holder at each protected **leaf** prevents rename/deletion of that directory and its ancestors before creation/writes; canonical paths and file identity are then revalidated. A real Windows ancestor-replacement regression checks this guarantee. Do not start a separate Node holder at every ancestor: that multiplied persistent helper processes by path depth and repeated shared ancestors. Creation is exclusive, including directories, git metadata and `AGENTS.md`. Git initializes an owned external seed with an empty template; its metadata is copied exclusively through pinned directories so git cannot follow an attacker-supplied `.git` or starter-file link. Inherited `GIT_*` overrides are discarded. Folder and runtime identity are rechecked after pinning; replacement interleavings refuse before launch writes. Replacement after pinning is denied by Windows. Bootstrap has exactly one Pi runtime and four lifetime holders: project, launch state, agent configuration and Telegram state (three if no separate Telegram state is configured). These counts are independent of path depth. Opening an existing folder uses one preparation holder, then two short-lived holders until readiness returns; at most six holders overlap a normal four-state startup. New-project preparation uses eleven finite holders cumulatively (project/root/runtime and exclusive git metadata leaves), all released before those three launcher holders. On Windows, a helper launched from a pseudoconsole may also own one hidden `conhost.exe`/`OpenConsole.exe`; these are counted separately, bounded to one per runtime/holder, and must also disappear on closure. Normal SDK runtime disposal closes holder stdin and awaits every helper's closure before the TUI completes its ordinary shutdown. Merely relying on bootstrap's `finally` is insufficient because the installed InteractiveMode exits after runtime disposal. This uses ordinary Node/Windows behavior, not a native addon or generated native source. Non-Windows creation fails closed.

This defends alias/replacement races, not a malicious same-account process that can terminate holders or tamper with the trusted installation/runtime. It is not a privilege boundary. Launch failures can leave an exclusively created new project; there is no automatic destructive rollback or retry.

Requests/readiness/session files stay in external runtime. Git-seed creation and cleanup also hold runtime ancestor pins, not only project pins. Readiness is atomically, exclusively published only after actual TUI-mode topic logon and, when requested, the first-instruction topic send plus the runtime's actual literal user-message event. Void dispatch alone is not confirmation; bootstrap observes asynchronous preflight failures and refuses. This does not wait for the model's whole reply. The launch instruction gates other startup input and inbound injection until accepted; competing local input is explicitly refused for resubmission, never persisted ahead of it. Known launch/logon failures refuse. There are no startup timers: if Windows Terminal never runs the bootstrap, confirmation remains pending rather than claiming success. Router registration/polling is not held by that wait. Do not blindly retry an uncertain launch. Runtime/session cleanup is an explicit local decision, never a timer.

## Machine checks

Set `PI_WINDOW_FROZEN_DEPS` locally to the read-only frozen `node_modules` root, then:

```sh
node --test agent/window/window.test.cjs agent/window/adapter.test.cjs
node --check agent/window/window.cjs
node --check agent/window/bootstrap.cjs
node --check agent/window/e2e.cjs
node --check agent/telegram-pi/forum-router.mjs
git diff --check
```

Tests use newly owned canonical external Temp children. They exercise actual Windows directory pins/junctions/replacements, exclusive initialization, auto-mode alias refusal, Telegram-state overlap refusal, and a causal production `openWindow` → request → bootstrap → installed SDK services/resource loader/session/extension lifecycle regression. That regression runs the production Telegram factory, real authenticated non-polling router IPC and actual persisted JSONL, while watching for transient project changes and checking file content/metadata with `.pi/settings.json` and legacy `.pi/commands` present. The original settings/privacy regression controls terminal presentation, model/auth and Bot API boundaries; readiness and persistence are not fabricated. A separate bounded topology regression runs the actual installed InteractiveMode and ProcessTerminal through the production launcher/request/bootstrap, production Telegram factory and real fixture IPC, controlling only the model/Bot API and substituting a piped terminal for `wt.exe`. Additive process-boundary observations reject a second bootstrap before execution, assert exactly one TUI runtime and four lifetime holders, account for every launcher helper, await natural closure and inspect OS processes for zero owned descendants. The fresh-staged new-project variant exercises the real E2E source copier, actual preparation/helper readiness and production `wt.exe` invocation options before substituting the piped terminal at that OS boundary; it must request a visible window. It also verifies the initialized git repository and lean starter file. No timer or forced termination is used. A competing startup submission must not precede the literal first instruction. Failed asynchronous auth preflight and unavailable configured defaults must refuse. They also exercise shared tool/command entrypoints through Pi's TS loader, literal prompt transport, one-use privacy and first-prompt priority, General authorization/deduplication/refusal, and real non-polling router IPC registration while `/new` is pending.

## Purpose-owned E2E harness

Run only with explicit permission for its one real TUI and throwaway project. Set `PI_WINDOW_E2E_ROOT` to the approved owned canonical external Temp root and `PI_WINDOW_FROZEN_DEPS` to frozen dependencies. Optional `PI_WINDOW_USER_AGENT` selects the usual user config directory. No bot token is needed: it uses the **existing** router's ordinary authenticated IPC, never a second poller.

`node agent/window/e2e.cjs stage` creates a fresh owned child and prints its path. It copies only candidate sources, usual model defaults/catalog, keybindings and local credential/model configuration into that external child (never hardlinks or live writes). A private copy of the existing router's session capability is used; no operator shutdown capability or live route/state files are copied. Launch `node agent/window/e2e.cjs launch <owned-child>` in the background with output in that owned child. `observe <owned-child>` checks its own topic, exact response marker, external session storage and graceful closure. After hello, an OS snapshot records owned bootstrap/Pi/helper processes and their parentage plus creation identities. Observation after closure checks all remembered identities and owned-path descendants, including orphans, rather than only the top PID; it reports startup counts (including positively parent-owned Windows console hosts) and requires zero owned survivors. The external observer excludes only its own process and temporary OS query, never an arbitrary helper. The literal E2E instruction includes suffix whitespace, which must survive in the first persisted user message. The temporary OS observer is explicitly excluded, not mistaken for an extra Pi runtime. Its additive observer delegates to the unchanged production Telegram entrypoint and records real authenticated IPC acknowledgements. After settlement it observes the actual terminal by its unique project label (Pi changes its full title during startup), then requests `ctx.shutdown()` only for this owned TUI. The launcher explicitly sets the owned label as the Terminal title and suppresses application title updates so startup cannot erase that label. If the Terminal profile retains an exited process, the positively identified owned window must also be closed via its normal UI before observation/cleanup can pass. Native window handles are useful but not mandatory: a positive unique-title UI observation followed by its disappearance, and absence of every owned runtime/helper process, is required. Missing observation preserves the test window for inspection instead of claiming closure. `cleanup <owned-child>` requires successful observations, then removes only its new project and its owned staging child. If observation/closure fails, report it; coordinator cleanup may finish only the owned test artifacts/window. A mocked transport test is not E2E. No sibling evidence directory is created; ordinary runtime observations remain in the owned child until cleanup.

## Owner card

In Telegram General: `/new demo-project say hello`. Or ask: “Open a new Pi window in my existing folder <folder>, and say hello.” Expect a separate Windows Terminal TUI and its newly labelled Telegram topic containing the instruction and hello. Send a later local-only message: it must not appear there. Existing-folder launch must leave its files/config untouched. A refusal or pending startup must never be described as success.

## Reversible cutover — separate owner word required

After the independent review, the coordinator alone may commit; no worker commit/push. Merge/install only after the owner's separate word. Copy only the reviewed `window/`, `extensions/window/`, Telegram adapter/core and router sources; keep existing local deployment/auth/config intact. Configure local `window.json` if needed. Keep previous source versions for rollback.

Perform **one orderly router-only restart** via its existing authenticated operator stop/drain and usual start procedure. Do not stop, reload or restart Pi windows. Already-loaded windows keep their current adapters until their normal future start; do not hot-upgrade them. Undo: restore the previous source files, leaving projects, sessions and credentials untouched. If a live transition was separately approved, reverse only that same router transition; otherwise no running process needs changing. No cutover is performed by this build.
