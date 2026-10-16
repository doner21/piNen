# The lean working method

Adopted by the owner on 5 October 2026 for item 3 and the SSI pivot. Made the standing method for all pi work on 6 October 2026.

## Why this exists

From mid-September to 4 October, orchestrator item 3 ran nine rounds over about three weeks under heavy proof rules. Those rules included per-edit chronology audits, before-the-edit timing proofs, reading statements, an audit after every builder, a nine-step test ladder and hash ledgers. Reviews kept failing on paperwork points rather than on the software.

On 5 October the paperwork was dropped and the safety rules were kept. Item 3 was then reviewed, fixed and committed in about four and a half hours, and its two follow-up fixes the next morning.

The SSI pivot finished its first milestone a day early under the same method. The lean reviews still caught real defects. The defect that would have stopped the orchestrator working altogether was found by the owner's two-minute real-use test, not by the paperwork.

This has happened before. A purge on 22 July 2026 found about 50 recorded tasks had produced 6 commits, and the repository was about 97% evidence files. The paperwork crept back one incident at a time. This document exists so it does not creep back a third time.

The lesson in the owner's words: **"We over constrained the models and made them less nuanced."** Heavy rules turned capable models into literal rule-followers that stalled, asked permission for everything, and built machinery to satisfy checks instead of doing the work.

## The hard lines (never bend; each says why)

1. **Protected code needs the owner's named permission.** This covers native audio code, the A/B swap, STOP, the audio callback, device code and allocation. Why: a mistake there can silence or damage audio for good, and tests cannot fully show it.
2. **The owner's data and working builds are untouched.** That means saved state, profiles, package stores and the demo build and launcher. Work in separate copies with separate paths. Why: loss of the owner's work cannot be undone.
3. **Never force-kill anything you did not start.** Why: earlier runs killed owner processes and lost work. Exception: you may stop your own test or worker process when it has written nothing for 30 minutes while blocking its parent. Check it really is yours and really is silent first, and say so afterwards.
4. **Add no timers, deadlines, sleeps, signals or exits** to product code, tests, fixtures or launch arguments. Why: they killed healthy long work. A null or absent timeout field that a tool's schema puts into your own tool calls sets no timer and is fine.
5. **Use the models the owner names for each role.** No substitution and no silent fallback. Why: wrong models produced wrong work under the right labels.
6. **Only the coordinator commits, and only after the review passes. Never push without the owner's word.** Why: a builder that committed before its review on 6 October bypassed the one check that matters.
7. **Never be idle silently.** If no worker is running and you cannot start the next one, send the owner one message at once. Say what is blocked, why, and the exact decision you need. Remind every two hours while still blocked. Never end a turn with nothing running and no scheduled wake. Why: runs sat dead for hours while looking busy.

## How work is proven

- **A fix is proven by a test that fails before the fix and passes after it.** The reviewer re-runs it. Nothing else is needed: no chronology, no timing proof, no hash ledger.
- **Faults you can hear are confirmed by listening first, and reviewed once at the milestone end (adopted 13 October 2026).** When a repair to something audible or visible builds and the agent's own quick check passes, the owner gets the listening card at once, with no reviewer in between. The milestone's one review covers that work after the owner has confirmed it. Exception: changes to protected code, STOP, the swap or saved-patch identity checks are still reviewed before the owner hears them. The agent's own check must measure what the owner hears, not the agent's theory of the cause. Incident: on 13 October the pivot ran three reviews in an hour on a fast-knob fix; the review passed because it tested the theory (the knob losing the mouse), and the owner found in minutes that fast drags still only changed the sound after release.
- **A failed listening card, or a fix that a review shows does not work, gets a blind planner next (adopted 13 October 2026).** Before the next repair, a fresh read-only planner gets only the owner's words describing the symptom and the source code. It does not get earlier diagnoses, earlier plans, the fix history or the coordinator's theory. It traces the whole chain from the owner's action to what the owner hears or sees, ranks the likely causes with what would disprove each, and names the production path the proving test must include. The repair brief is written from its findings. If a second blind planner is wanted, it is also kept blind to the first. This does not apply to reviews that fail on test setup, tooling or evidence filing; those are fixed directly. Incident: the fast-knob fault failed three listening cards over two days. Every repair run had a planner, but each was briefed with the previous theory and the inherited fix. The first blind planner, asked on 13 October, found the real cause within an hour (a preview rebuilt sixty times a second, blocking the knob values, and missing from the test), and the next build passed the owner's ears.
- **One fresh independent review at each milestone boundary,** from a reviewer that never saw the build conversation. Add an extra review only for changes to protected code, or when the owner asks. There are no reviews after every batch.
- **The owner's real-use test is the definition of done.** Give a short test card: what to do, what should happen, what failure looks like. Machine checks are the agent's job and are never handed to the owner.
- **Known limitations:** anything that cannot be proven on this machine without breaking a hard line goes on one list, approved by the owner once. Approved entries no longer block a pass.
- **The test-tooling cap (adopted 13 October 2026).** Writing the proving test, including any fixture, harness or driver it needs, gets **at most two hours of worker time per fix**. Incident: the pivot's live-knob fix took hours; proving it with an automated test through the Electron stack took a day and a half. When the cap is reached:
  1. prove the fix with the **cheapest machine check that exists already** (a unit test at the lowest layer where the defect shows, a log or snapshot assertion, an offline render), and
  2. put the behaviour on the **next listening card** for the owner, batched with everything else waiting to be heard. The owner's ears are the proof. A listening session finds more in ten minutes than a day of tooling.
  Pick the smallest layer first: never build a new UI or end-to-end driver to prove something a unit test can show. Note on the card which items were proven by ears only. If the same tooling would have served three fixes, build it once as its own small task, not inside a fix. The cap does **not** apply to safety checks the owner cannot hear: trust, refusal, isolation and protected-code tests are proven by machine however long that takes.

## Milestone pull requests (adopted 13 October 2026)

- **Lane merges between milestones stay local.** The coordinator is the single integration owner and merges reviewed lanes on the owner's machine.
- **At each milestone end,** after the owner's listening pass and the milestone review, the coordinator pushes the milestone branch to the project's GitHub repository and opens **one pull request into the main branch**, with a short plain description: what changed, what the owner tested, the review result.
- **The coordinator never merges the pull request.** The owner says "merge" or merges it on GitHub. Pushing for this purpose is authorised; any other push still needs the owner's word.
- Why: all reviewed work lived only on one PC, and the owner had no single place to see a milestone's changes and verdict. One pull request per milestone gives that page, an off-machine copy and a clean undo, without a pull request for every step.

## What is dropped

Chronology audits, per-edit timing proofs, reading statements, hash and pin inventories in reports, receipts, evidence folders, role ledgers, closeout documents, per-batch release tasks, whole-tree re-verification at every step, and audits of audits. Builder reports are short: what changed, the exact commands, the results.

## Judgement, not literalism

- **Every rule carries its reason.** Apply the reason, not the letter.
- **A check that you or another agent invented,** and that is impossible or out of proportion, gets replaced. Use the simplest check that still protects the real rule. Note it in the handoff and carry on. Two examples:
  - requiring a folder's last-access time to stay unchanged, which Windows updates whenever the folder is read;
  - treating a null timeout field as a timer.
- **Stop for the owner only** for things that are genuinely theirs:
  - protected-code permission;
  - live hardware windows;
  - scope changes;
  - destructive actions on their data;
  - a material choice about how something should sound or behave.
  What each of these means, what is *not* protected, and what to do while the owner is away: `C:/Users/you/.pi/agent/docs/standing-permissions.md` (adopted 13 October 2026 after a third of the first fortnight went on unneeded waits). A question never stops the run; only the task that needs the answer waits.
- **A disputed verdict is not a stop (adopted 13 October 2026).** If a reviewer's FAIL reasons are contradicted by its own evidence, or by something the coordinator directly observed, the coordinator says so in one line, gives the reviewer the missing evidence, and reruns the review. That rerun is a three-minute step, not a repair and not a waiver. Stop only if the rerun still fails, or if the reviewer found behaviour that is actually wrong. Incident: the round 8 real-use card passed every behaviour it tested, the reviewer failed it because it read the saved launch reply as a current pause and asked for a record of something it had already quoted from the program log, and the coordinator, told "never accept around FAIL", parked the run instead of resolving a contradiction it had itself written down.
  - Never write "FAIL for missing proof" or "no acceptance waiver" into a brief. FAIL is for behaviour that is wrong. Missing evidence is a request for evidence.
  - Before a reviewer starts, the coordinator writes what it observed from outside the run (times, actions it took, what it saw survive) into a short note in the run folder, so the reviewer judges the same facts.
  - A coordinator session that has run for days is replaced by a fresh one at the next milestone with a short handoff, rather than nursed along. A session whose wake-up notes have become shorthand is already past that point.
- **Set a cutoff for any exploratory step:** how many attempts, and what fallback to take afterwards. When the cutoff is reached, take the fallback. (The pivot spent 13 workers on one step until a two-worker cutoff ended it.)

## Long work runs headless

- **Never run a long test, build or launch as a blocking foreground command.** Start it in the background, send its output to a log, check the log with quick commands and schedule your own check-ins. A blocked agent cannot rescue itself.
- **Build work runs in headless workers,** one folder per worker, so the coordinator stays free to talk to the owner and to watch.
- **For orchestration, wrap `/orchestrate` in a headless pi process** whose only job is to run that orchestration to the end. The coordinator outside it checks the run's files every 10 to 15 minutes, forwards alarms to the owner, and answers messages straight away.
- **Never let the orchestrator edit the copy of itself that is running.** Build orchestrator changes in a separate git worktree.

## Keeping the rules lean

- A new rule must name the incident it prevents. No incident, no rule.
- At each milestone, look at the rules. Delete any rule that has caught nothing for several runs.
- When a rule causes a false failure, fix or delete that rule. Do not add another rule to explain it.
- Prefer a re-runnable test or one independent review to a document. If something cannot be checked by running it, it probably protects nothing.
- Keep briefs short and plain. Say what to build and why before saying what not to do.
