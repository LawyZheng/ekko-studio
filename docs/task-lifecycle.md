# Durable task lifecycle (session goal, original card, avatar)

A session goal (`session_tasks`) can carry a durable lifecycle. Its stable id is the only outcome
authority; its task card and the session avatar are projections of the same committed state.

## Linking a goal to its original card

`ekko_studio_update_plan` accepts an optional `task_id` (a goal id from `ekko_studio_list_session_tasks`).
The first plan save links the open goal to that card in one transaction. Later turns that pass the same
`task_id` update the SAME card: its `plan_id`, `run_id`, `created_at` and place in the transcript never
move. A turn can link only goals of its own session (the server binds the session from the turn context).
Cards without `task_id` are run-only legacy cards and behave as before.

## States

| Phase | Entered by |
| --- | --- |
| `open` | link, rework, resume without a producer |
| `starting` | a trusted launcher reserved the attempt |
| `running` | an owned producer was bound (shown as background execution after the turn ends) |
| `waiting_user` | live Hermes turn or PM: `wait_user` with `login`, `consent` or `decision` |
| `verifying` | the current producer delivered a result reference, or the parent delivered foreground work |
| `failed` | the current producer reported failure (non-zero exit, Stop) |
| `lost` | exact reconciliation found the owned handle absent |
| `unknown` | Studio restarted or the producer cannot be reached now; never shown as running |
| `done` | `accept` of the current delivery and verification; the goal becomes `completed` in the same commit |

Exit code 0, completed plan steps, `update_session_tasks status: completed` and the manual task-list
"completed" never complete a linked goal; the common goal store rejects them. The user can still close it.

## Authority and fencing

- Producers (worker side) can only `start`, `deliver`, `fail` and be `reconcile`d through the in-process
  port `modules/studio/public/task-lifecycle.ts`. A producer cannot verify or accept.
- A live Hermes turn uses `ekko_studio_task_lifecycle` (`POST /api/studio/task-lifecycle/action`, run
  credential + current `context_id`) for `wait_user`, `resume`, `deliver`, `verify`, `accept`, `rework`.
- A PM/user uses `POST /api/studio/sessions/:id/tasks/:taskId/lifecycle` with an interactive login token
  and access to the session; model-run, run-scoped, App, server, model-key, pre-purpose and share credentials
  are refused. The actor always comes from the host context. `ekko_studio_list_session_tasks` shows the live
  turn each linked goal's phase, revision, `delivery_id` and `verification_id`.
- `accept` requires the current `delivery_id`, the recorded `verification_id`, `expected_revision` and
  non-empty evidence. `rework` starts attempt N+1 and invalidates owner and receipts.
- Every write compares the session incarnation, goal revision, attempt and owner inside one SQLite
  transaction that also writes the goal status and the original card projection. Event ids are idempotent
  (same content: duplicate; other content: conflict). Callbacks of an older attempt or owner change nothing.
- A producer binds only to the exact attempt pinned by the turn's own `update_plan(task_id)` or lifecycle
  results, in bridge event order (bridge events are buffered and drained later). An external rework never
  appears in that stream, so an older spawn cannot bind to the new attempt; a turn's own rework re-pins only
  later tools. Without such a result in the turn, nothing binds. A known producer incarnation must match.
- A terminal event without a turn context that names another run (marker, run or response id) has no effect
  at all: no card/credential change, working state, activity/App publication, room delivery or waiter.
- A process completion receipt is stored before the lifecycle write; a replay or reconciliation re-applies
  the lifecycle from that receipt (idempotent), and the continuation turn is still dispatched once.

## Supported producers and boundary

| Producer | Bound at | Delivery / failure | Reconciliation |
| --- | --- | --- | --- |
| Hermes `terminal(background, notify_on_complete)` | tool result (`session_id` = process id) in a linked turn | process completion (`exit 0` → verifying, else failed; Stop → failed) | bridge `process_inspect` by exact process id and session |
| Hermes async delegation | dispatch result (`delegation_id`) | delegation completion notification | none (stays `unknown` until its completion) |
| Trusted launcher in Studio code | `reserve` + `start` with its own handle | its own observation | its own handle |

An arbitrary external worker (for example a Codex or Claude CLI started by a command) is visible only as
the Hermes background process that started it: Studio sees spawn, exit and exit code, not its internal
progress. There is no worker HTTP endpoint and no timeout-based liveness.

## Restart and projection

On startup every `starting`/`running` producer becomes `unknown` (a waiting producer keeps `waiting_user`
but will resume to `unknown`); delivered/verifying state is kept. A failed background poll also turns owned
producers `unknown`. After startup, recovery, a bridge replacement and every 30 s while producers are owned,
each Hermes process is asked for by id: a stored completion receipt is applied first, then present →
`running`, exited → its native exit code (0 → `verifying`, else `failed`; covers a completion that Hermes
`wait`/`log` consumed) or `unknown` when no code is reported, absent → `lost`, unreachable → `unknown`. `resume` of an owned producer shows `unknown` until it
is observed again. The session-state socket adds `task: { state, count }` computed from all
linked goals of the session's current incarnation, with precedence
`waiting_user > running/verifying > failed/lost/unknown > open > done`. The foreground `working` flag is
unchanged and session state adds `foreground`; the avatar shows the task state separately: waiting for the
user outranks everything, a foreground run's ring hides older badges, and background-only counts never hide
the task state. The card header always shows the lifecycle label, also collapsed.

## Verification

```bash
npm test -- tests/server/task-lifecycle.integration.test.ts tests/server/chat-run-task-lifecycle.test.ts \
  tests/server/task-lifecycle-producer.test.ts tests/server/task-lifecycle-auth.test.ts tests/server/task-lifecycle-bridge-drain.test.ts \
  tests/server/session-state-task-summary.test.ts tests/client/task-lifecycle.test.ts tests/client/session-avatar-lifecycle.test.ts
npm run test:e2e -- tests/e2e/task-lifecycle.spec.ts
```
