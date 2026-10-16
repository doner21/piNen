# Standing permissions

Adopted by the owner on 13 October 2026. Why: over the first fortnight of lean work, roughly a third of elapsed time was spent waiting for permissions that were not needed, or that were asked in a way that stopped all work until an answer came. One repair waited seven and a half hours overnight for approval to edit ordinary TypeScript. This page says, once, what needs asking and what does not. Briefs point here instead of restating it.

## 1. An approved brief is permission to build it

When the owner approves a brief, a milestone or a repair, that approval covers **every task in it** except the two things below. Do not ask again task by task. Headers in intakes such as "not permission to build" describe the document before approval; once approved, they no longer apply.

## 2. The two things that always need the owner's named permission

1. **Native code**, meaning any file under:
   - `experiments/phase0/parallel-crossfade/` (the audio host, the service core, the A/B crossfade, STOP, the audio callback, the device lease);
   - `tools/phase1/native/` and the native parts of `tools/stage6/`;
   - the CMake and build files that produce those binaries;
   - any new native source or generated native source, wherever it lives.
2. **A live hardware window**: opening the owner's audio devices or a MIDI controller with a build the owner has not yet agreed to hear, or closing the everyday demo to do so.

Why these two: a mistake there can silence or damage audio for good, or lose the owner's working build, and tests cannot fully show it.

**Everything else is not protected.** In particular, TypeScript and harness code that *talks to* the native host through its existing protocol (the IPC client, the live spine adapter, the replacement transaction, the harness, the Electron main process, startup reconciliation, snapshots, the control room, the launcher's TypeScript) is ordinary product code. Edit it, test it and have it reviewed like anything else. The native side enforces STOP and the lease; a TypeScript caller cannot bypass them. Incident: the pivot waited overnight to repair startup reconciliation because "replacement path" sounded protected.

## 3. The other things that are genuinely the owner's, and what to do while he is away

| Question | Ask? | If no answer within two hours |
|---|---|---|
| How something should **sound or behave**, where the docs do not say | Yes, one message with numbered options | Take the option closest to the existing docs, say which you took, carry on. The owner can reverse it at the real-use test. |
| **Widening scope** beyond the brief | Yes | Do not widen. Finish everything else in the brief. |
| **Destructive action on the owner's data or builds** | Yes | Never proceed. Keep working on everything that does not need it. |
| The two protected items in §2 | Yes | Keep working on everything that does not need it. Write the exact request once; do not re-draft it. |
| A **test card is ready** for the owner to hear or use | Yes, send the card | Continue the next tasks that do not depend on his verdict. |

Rule for all of these: **a question never stops the run.** Only the task that needs the answer waits. If every remaining task is blocked, write the handoff and the test card, say so once, and remind every two hours (hard line 7).

## 4. How to ask

- One Telegram message in the window's topic, and the same text in the window itself. Say the decision in one line, give numbered options, and name the one you recommend. The owner should be able to answer with a single word or number.
- Batch questions. If you have two, send them together.
- Do not ask the owner to confirm your reading of an instruction. **The latest instruction wins.** If two conflict, follow the latest, say in one line which you followed and why, and continue. Incident: P7 waited an afternoon for confirmation of an instruction reading.
- Do not ask about engineering details: file names, identifiers, test shape, which check to use, how to isolate, which fixture to fix. Decide and note it.
- Do not ask for permission to **repair something you broke**, to fix a test or fixture, to replace an invented check, to retry after a provider drop, or to resume after a reboot.

## 5. Orchestrated runs

- Launch orchestrations with `automaticPlanApproval: true` whenever the brief has already been approved by the owner. The orchestrator then approves an intact initial plan after its own in-scope and protected-area checks, and the final independent review still judges the result. (Available from orchestrator round 8, commit `194bd02`, once merged.)
- The stop rule for a run is **product defects only**. Test-setup failures, import paths, scratch-folder problems and tooling faults are fixed by the run, not parked. Incident: round 8 parked twice on test-setup issues.
- A plan checkpoint that cannot be auto-approved pauses only that run; the coordinator says so once and keeps watching.

## 6. Keeping this page honest

Add a line here only for an incident that cost real waiting time. If a rule above causes a wrong action, fix the rule here; do not add a second rule to explain it.
