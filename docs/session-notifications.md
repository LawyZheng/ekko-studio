# Session notifications (Hermes cron results, terminal completions and external notices)

Studio delivers Hermes background results, and notices posted by authenticated external
services, to an exact Studio session, whichever session is currently selected.

| Producer | Delivery | Model context |
| --- | --- | --- |
| Scheduled cron fire of an agent-backed job bound explicitly to a Studio Hermes chat | Passive notice in the creating session's timeline, durable across reload and restart, sidebar attention raised once | Not automatic. The next intentional user question in that session receives a bounded, once-only context block |
| `terminal(background=true, notify_on_complete=true)` completion | Typed machine event that starts one turn in the owning session after any running turn | Yes: the native Hermes completion text, with the session's current history |
| `POST /api/studio/sessions/{id}/notifications` from an external service | Passive notice, like a cron result | Like a cron result: once, on the next intentional question |

## Cron results

Hermes captures a cron `origin` only from a chat id. The Agent Bridge has none, so Hermes
stores `deliver=local` and never routes the result back. Studio fixes this without
changing Hermes:

1. **Explicit binding.** `POST /api/hermes/cron/session-bindings` with
   `{ profile, session_id, expected_session_generation, job_id }` binds an existing
   agent-backed native job whose stored `deliver` is `local` to the session's frozen generation.
   It writes `<Web UI home>/session-notifications/cron-bindings.db` and changes nothing in
   Hermes. It needs an interactive login token (signed `purpose: "login"`) as a bearer header,
   so a model run cannot bind on its own; a model run asks the user instead (see
   [Consent requests](#consent-requests-model-initiated-delivery)). Script-only jobs are refused
   (`422 script_job_requires_script_report`), and explicit targets (`slack:…`, `all`, …) are
   refused (`422 explicit_delivery_target`) and never mirrored.

   **Session generation.** `getSessionGeneration` returns the session's `generation_id`:
   assigned on first read, cleared by `clearSessionMessages` (reset), and new for a session
   recreated under the same id. Studio sends it with each bridge turn
   (`studio_session_generation`), and the binding records the generation the caller froze.

   **No runtime patches.** Earlier versions wrapped the registered `cronjob_manage` handler
   inside the Agent Bridge, replaced its availability check and cleared Hermes tool caches so
   chat-created jobs were bound automatically. That in-memory modification of Hermes is
   removed. Consequences: a job a model creates with `cronjob_manage` in a Studio chat is a
   plain native job (`deliver=local`) and is not bound until the user approves a consent
   request for it (or binds it directly with a login token); and
   `cronjob_manage` is offered to Studio bridge agents only when Hermes' own availability check
   allows it.
2. **Observation.** Every 15 seconds `ChatRunSocket` asks the profile's bridge worker
   (`studio_cron_observe`) for the terminal executions of bound jobs. The worker reads
   the native execution ledger (`list_executions`) a bounded page of 50 at a time: the
   newest page plus one older page per pass, continuing from the job's stored
   `observe_before` cursor (`before_claimed_at`). A backlog larger than one page is
   recovered over later passes while new fires keep arriving, and each execution is
   still accepted once. For agent-backed fires it also reads the canonical
   admission result of `cron_request_id(job, execution_id)`, which holds the exact
   final response. Output files are never correlated by name or time. Only scheduled
   fires are observed. A chat `cronjob_manage run` returns through its own
   async-delegation result. Studio registers that delegation from the tool result
   (`job.execution_mode == 'background'`, `job.delegation_id`), so the background poll stays
   active until the result is delivered once.
3. **Inbox.** Each execution is accepted once under
   `(instance, profile, cron:<job>:<execution>)` in `session_notifications`, with its
   disposition, payload, accepting session generation and its durable attention event
   (`session_attention_events`, key `cron-notice:<id>`) written in one transaction.
   The existing read cursor (`sessions.read`) clears it; a replay never re-arms it.
   - Replays (restart, a second poll) are rejected.
   - Ownership requires the same profile and an exact match between the binding's
     generation and the session's current generation. A deleted, reset or recreated session,
     or a binding without a generation, fails closed as `owner_missing` and is never
     rerouted.
   - An out-of-band edit of the native `deliver` value to another target stops
     observation (`target_changed`).

| Disposition | Meaning | Shown |
| --- | --- | --- |
| `notified` | Exact final response from the native receipt, or a known failure (`success=false`, with its error) even when the answer is empty or silent | yes |
| `status_only` | No exact receipt: `no_agent`/script jobs (`output_unavailable_for_runtime`), or an agent-backed fire without a readable receipt | yes, status only |
| `unknown` | Native execution outcome unknown; Studio never re-runs it | yes |
| `silent` | Successful fire with the Hermes silence sentinel (`[SILENT]`, `NO_REPLY`, …) via Hermes' own matcher | no |
| `no_content` | Successful exact receipt with an empty answer | no |
| `owner_missing`, `target_changed` | Fail-closed outcomes | no |

Notices are not rows in `messages`, so they never become model history. Resume and the
paginated messages API merge them into the timeline as `role: 'system'` items carrying
`studio_notice`. They are scoped to the session generation that accepted them: a real
history clear or a delete and recreate under the same id hides them from the API, the
next-question context and attention (the attention rows are removed), while ordinary
turns and partial message deletion keep them. On each page a notice belongs to the
interval between the next older stored row and the page's newest stored row (equal
timestamps go to the older page), and `offset` keeps counting stored rows only, so the
client advances by stored rows and no notice is skipped or repeated across pages. Both
clients that page this API (the chat view and History) count stored rows only and keep a
notice's `studio_notice` metadata, so History shows its attribution, the known error of a
failed run without result text, and the status-only explanation.

Live `session.notice` events go to members of the session room and to signed-in account
sockets, and every one of them is authorized again when the notice is published, with the
read rules of `resume` applied to the session as it exists now: the user must be able to
access its current profile (person-private sessions: their owner only; a share viewer: its
shared session only). A socket that joined the room before the session was deleted or
recreated under another profile receives neither the content nor the metadata. Deleting a
session (HTTP single or batch delete, and every deleting `disposeSession`) also removes all
sockets from its `session:<id>` room synchronously, before the first await, and the HTTP routes
do so again immediately before removing the Studio row (a viewer may rejoin while the native
Hermes delete is pending, because the old row still authorizes it), so a session
recreated under the same id never streams its runs (including terminal-completion turns) to
viewers of the old one; joining again goes through the `resume` read checks. `/destroy` and a
same-owner history clear keep their viewers. Studio
login cannot be disabled (`isAuthEnabled()` is always true), so every ordinary chat
socket carries a user; a socket without one is never a recipient.

**Next-question context.** The block for the next intentional question holds at most
three notices and 8000 characters in total, including framing and metadata. Job names
and results are quoted as escaped JSON strings and labelled untrusted task data.
Notices that do not fit are not marked projected and reach a later question.

**`attach_to_session` is not supported.** Studio translates the delivery target to
`deliver=local`, so a pass-through `attach_to_session` has no effect, and the
next-question block is not native attachment.

**Script-only jobs.** Hermes keeps no execution-keyed receipt of a `no_agent` job's
successful output or silence, so a bound native observation can only report status. Use a
script invocation report instead.

## Script invocation reports (opt-in, script-only jobs)

Hermes keeps no execution-keyed receipt of a `no_agent` job's successful output or silence. A
prospective, explicitly enrolled `no_agent` job therefore runs an Ekko-generated wrapper instead of
the target script. The original Hermes scheduler still decides when it runs, claims it, times it
out and keeps its own ledger and output documents. Nothing in Hermes is patched and there is no
second scheduler, model turn, browser token or network listener.

```text
Hermes scheduler -> scripts/ekko-script-reports/<binding>.py (wrapper) -> target script
wrapper -> <Web UI home>/script-reports/spool/<binding>/<invocation>/ -> Studio importer (15 s)
        -> generation-fenced passive notice in the bound session
```

**Identity.** Each launch of the wrapper gets a fresh UUID (`identity_kind: wrapper_invocation`).
`native_execution_id` is always null. A report says what this invocation of the wrapper observed;
it is not a native execution receipt and does not prove that Hermes committed the run. Every launch
is reported (scheduled, `hermes cron run`, or a direct start); there is no scheduled-only filter
and no deduplication by time or content.

**Enrollment.** `POST /api/hermes/script-reports/enrollments` with
`{ profile, session_id, expected_session_generation, name, schedule, script, workdir?, interpreter?, paused? }`
and an interactive login token (signed `purpose: "login"`) as a bearer header; model-run, App and
share credentials are refused. `script` is relative to the profile's `scripts/` (`.sh`, `.bash`,
`.py`; no traversal or symlink escape; behind a symlink inside `scripts/`, the resolved file and its
extension decide the interpreter, as in Hermes). Studio:

1. checks the account (active, profile access) and that the session is an ordinary local Hermes
   chat whose current generation equals the frozen one;
2. writes a private manifest (`script-reports/bindings/<binding>/manifest.r1.json`, 0600: target
   resolved path, SHA-256, native working directory, spool) and a private spool (0700);
3. records the binding as `enrolling` and runs
   `hermes cron create --paused --no-agent --deliver local --script <target> …` with the **original
   target**, so Hermes' create-time lifecycle guard validates the real script. A refusal creates
   nothing (`422 native_create_rejected`). The job id comes from that command's own `Created job:`
   line, never from a job-list diff, and is recorded at once;
4. writes the generated wrapper to `<profile>/scripts/ekko-script-reports/<binding>.py` and points
   the job at it with `hermes cron edit <job> --script …`;
5. verifies the stored job by id (wrapper script, `no_agent`, `deliver=local`, paused), activates the
   binding and resumes the job unless `paused: true`. If the binding was revoked meanwhile it is
   never resumed (`409 binding_revoked`).

Enrollment and revocation of one binding never interleave. The plan (target path, kind, SHA-256,
name, schedule, working directory, interpreter, resume intent) is frozen before any write; the
manifest records that approved digest, and the destination and target are checked again after the
native create and edit, before activation and resume, and once the resume returns. While the job is
being created, Studio-managed job edits in that profile wait, so the stored configuration Hermes
created from the plan is the one verified (every stored field except run-time bookkeeping, with the
wrapper in place of the target) before activation and after resume. If anything was invalidated by
the time the resume returns, the binding fails, its wrapper becomes a passthrough and the job is
paused again and verified, with its id returned. A failure after creation leaves the job
paused and returns its id. Nothing is migrated; an existing job reports only after an explicit
adoption (below).

**Adopting an existing job** (consent only, `mode: "existing"`): a `no_agent` job with
`deliver=local` starts reporting its **future** invocations. Under a per-job lock Studio re-checks
the approved job configuration (every stored field except run-time bookkeeping) and target bytes,
requires the job to still be scheduled or paused exactly as when it was proposed (a later user
pause or resume makes the request stale), checks that the configured script spelling (an in-profile
alias is fine) still resolves to the approved file,
runs Hermes' own create-time lifecycle guard on the target through a read-only helper
(`assets/script-reports/ekko_native_guard_check.py`, because native `update_job` never re-runs it),
refuses a job with a claimed or running execution, pauses it, points it at a generated wrapper,
verifies that only the script changed, re-checks the destination, activates the binding and resumes
the job only if it was scheduled at consent time. A failure leaves it paused with the binding marked
failed and its job id recorded. There is no duplicate job and no historical backfill.

`GET /api/hermes/script-reports/enrollments?profile=` lists the caller's bindings with import counts
(`accepted`, `silent`, `rejected`, `quarantined`) and `incomplete` invocations.
`POST /api/hermes/script-reports/enrollments/{binding}/revoke` is final: it writes a revocation
marker (the wrapper then runs the target directly and captures nothing), stops importing and pauses
the native job. The wrapper file and job configuration are left for the user to remove.

**Wrapper** (POSIX; synthetic Bash and standard-library Python verified):

- The target must still be the enrolled file: same resolved path (no symlink swapped into it or an
  ancestor), a regular file, same SHA-256. Otherwise the wrapper exits 2 without starting it, also
  for a revoked binding. Changing the target means revoking and enrolling again.
- Interpreter as in Hermes: `.sh`/`.bash` under `bash`, other files under the Python Hermes chose for
  the wrapper (the job's `interpreter` when set). The working directory is the job's `workdir`, else
  the target's folder. Streams are relayed byte for byte; the exit status is the target's, and a
  target killed by a signal makes the wrapper die by the same signal. The target stays in the
  wrapper's process group, so Hermes' timeout and cancellation reach it and its descendants.
- Classification follows Hermes: a nonzero exit is a failure even if the output is silent; on exit
  0 a final `{"wakeAgent": false}` line, empty output or a silence marker is silence. Successful
  stderr is never a body.
- Capture is bounded (1 MiB per stream; beyond that no body and no silence inference). The body is
  sanitized before the first durable write with linear rules (Authorization headers, bearer/basic
  tokens, URL credentials, secret-named assignments including escaped quoted values, whole object or
  array values and assignments nested in other values, PEM keys, JWTs, common key formats), clipped to 32 KiB, and the whole
  record is kept under 92 KiB by further truncation. NUL bytes are shown as `␀`. If sanitization
  fails the body is omitted.
- Before the target starts, the wrapper must reserve its invocation under an exclusive lock: a full
  spool (200 pending), a spool that is not private or not writable exits 2 and the target does not
  run. After the target has started, report storage errors never rerun it and never change its
  streams or exit status; the invocation then stays `incomplete`.

**Import.** On each 15-second cron observation pass Studio also reads at most 50 finished reports per pass from active and
revoked bindings. The binding, never the report, chooses the destination. Each report is validated
strictly and accepted once under `script-report:[binding, revision, invocation]` with the frozen
generation:

| Wrapper outcome | Disposition | Shown |
| --- | --- | --- |
| `output` | `notified` | yes, as Markdown, with attention |
| `failed`, `launch_failed` | `notified` (failure title, sanitized diagnostic) | yes |
| `silent` | `silent` | no, and no attention |
| `interrupted` (the wrapper was signalled) | `unknown` | yes |
| `output_unavailable` | `status_only` | yes |

The chat bubble renders the stored body with the same Markdown renderer as agent-backed cron
results (GFM tables, lists, links, code), so a plain multiline log keeps its line breaks. Raw HTML
is escaped, unsafe link schemes stay inert and images are not loaded; copy returns the raw body.

Studio sanitizes the body again on import. A report is dropped, never rerouted, when the binding is
revoked, the account is inactive or lost profile access, the session was reset or recreated, or the
native job no longer runs the enrolled wrapper with `deliver=local` (`target_changed`; checked
against `cron/jobs.json` on every pass). A different report under an accepted identity is
quarantined. A rejection or quarantine is final: a report replayed after a crash is not accepted
even if its destination has become valid again, and a replay that finds its notice already committed
records the acceptance. An acknowledged entry leaves the spool in one rename to a dot tombstone,
which later passes remove, so an interrupted removal never leaves a settled report behind. The spool entry is removed only after its disposition is durable, so an importer killed
before the inbox commit imports the report on its next pass and one killed after the commit only
records a duplicate. An invocation with `started.json` but no final report (still running, or
killed with SIGKILL as Hermes' timeout does) stays `incomplete`; its outcome is never inferred from
elapsed time. Studio never launches, retries or reruns a script.

**Limits.** Local POSIX only, Studio and Hermes under the same OS user (file permissions are the
trust boundary; another process of that user can forge a report or swap a file between the
wrapper's check and the launch). The wrapper does not reproduce Hermes' managed-store Python
bootstrap, so a Python target importing Hermes' own packages is unsupported. The sanitizer is
conservative pattern matching and cannot recognize an arbitrary password in prose. Like cron
notices, a shown report is projected once, as escaped untrusted data, into the session's next
intentional question. The login API above stays available; model-initiated enrollment goes through
consent requests.

## Consent requests (model-initiated delivery)

The direct binding and enrollment endpoints accept only a login credential. A model turn's ordinary
MCP runtime credential (`model_run`, written to `<profile>/.model-run-token` at turn start) is
refused there (`403 login_token_required`, with `hint: request_user_consent`). It may instead
**request** consent; only the same account's login credential can approve it.

```text
MCP (model_run) -> POST /api/hermes/cron/consent-requests  { profile, context_id, kind, ... }
               <- 202 pending_user_consent              (nothing created or run)
Studio chat card (login) -> approve | deny -> existing executor runs the frozen plan once
```

- **Authority.** `context_id` names a server-created authority: the current turn's context (the
  `context_id` in `studio_task_plan_context`; Studio records the account that started the turn) or
  a setup context the user opened from the chat menu ("Allow MCP scheduled-result setup",
  `POST /api/hermes/cron/consent-contexts`, login only). A setup context needs no model turn; opening
  it issues the profile's ordinary runtime credential through the real issuer. It is single use, and
  opening a new one replaces the account's earlier unused setup context for that session.
  The destination session, profile, account and frozen generation come from that authority; a body
  `session_id` or generation is refused (`destination_override_refused`). Invented, ended or
  background-continuation contexts are refused (`context_unavailable`), as is a context of another
  account (`context_account_mismatch`).
- **Cross-session target.** An optional `target_session_id` asks for delivery into another session.
  The context stays the origin authority: the request, its card, capacity and refresh hints stay in
  the context's session, and the card names the target by title, stable id and profile. The target
  must be a session of the same profile attributed to the requesting account; unknown or
  other-profile (`target_session_not_found`), unattributed (`target_session_unattributed`) and
  other-account (`target_session_account_mismatch`) targets are refused. Its generation is frozen at
  request time and rechecked, with the origin, at approval, once the job lock is held, and after the
  native create/edit awaits before the job is activated or resumed. Naming the context's own session
  is the same-session request.
- **Credential boundary.** The runtime credential is account-wide by existing architecture. A valid
  context of another session or profile of the same account can therefore be named; the request
  then visibly targets that context's session and still needs that account's login approval. This
  is not isolation between one account's sessions.
- **Account.** A session attributed to a Studio account accepts requests only for that account; an
  unattributed session accepts the authorized actor without changing its ownership. Only the
  requesting account can list, approve or deny (no super-admin override). App, share, server, model
  API key and pre-purpose tokens cannot request or decide.
- **Kinds.** `cron_session_binding` + `job_id` (agent-backed, `deliver=local`): approval records the
  binding with the approving account; the observer stops delivering once that account is disabled or
  loses profile access. `script_report_enrollment` + `mode: "new"` (`name`, `schedule`, `script`,
  optional `workdir`, `interpreter`, `paused`) or `mode: "existing"` + `job_id` (adoption above).
- **Frozen plans.** Approval executes only what was shown. Agent binding: the job configuration
  fingerprint (run-time bookkeeping excluded) and the binding it replaces are compared and set, so a
  changed job (`job_changed`) or a binding changed meanwhile (`binding_changed`) is refused instead of
  last-writer-wins. Scripts: changed bytes or resolution are refused (`target_changed`), never
  re-hashed as approved. A reset, deleted or recreated session (`session_generation_mismatch`) or an
  account that lost access is refused at approval, once the job lock is held, and after the native
  create/edit awaits before activation or resume (an adoption's initial pause can precede its next
  check; nothing is activated without one).
- **State.** In memory, 10-minute expiry, at most 5 pending requests per account and session. A
  decision consumes the request synchronously (one winner among concurrent clicks; a wrong account
  never consumes it). A Studio restart drops all pending requests. Approval is at most one execution
  attempt in that process; it is not a transaction across the Hermes CLI, files and SQLite, so a
  failure can leave a paused job, whose id is returned, and nothing is retried automatically.
- **Mutations.** Consent application, direct binding and Studio's job API (`PATCH/DELETE`, pause,
  resume) serialize per job, and authorize again once they hold the lock. Native tools and other same-UID processes are outside that lock: a binding subscribes the
  job's future results and does not freeze the job against later native edits.

## Trusted current-session automation (opt-in)

Like a messaging gateway, an account can let its chats set up recurring Cron delivery into the
**current** session, or into another of its own sessions, without a per-job approval. Off by default, per Studio instance, account and
profile; consent requests stay the default everywhere else.

```text
GET /api/hermes/cron/trusted-automation?profile=P          -> { profile, enabled, revision, updated_at }
PUT /api/hermes/cron/trusted-automation  { profile, enabled, expected_revision }   (login only)
```

- **Control.** Only an interactive login credential of an account with access to the profile reads
  or changes its own policy (compare-and-set on `revision`, `409 policy_revision_conflict`). Runtime,
  run, App, share, server and pre-purpose tokens are refused, including a super administrator's
  runtime credential. Every change of `enabled` rotates an opaque epoch. No settings UI is needed;
  operators call the endpoint with their login token.
- **Authority.** While the policy is on, Studio issues an admission authority for each live chat
  turn of that account: bound to the turn, session, generation, account, profile and policy epoch,
  held in memory only and revoked when the turn ends. The Bridge attaches it per call as MCP
  `_meta` to Studio's verified managed API server only; the model never sees it and it is never
  written to a file. Without it (policy off, another account's turn, a group, workflow, background
  or shared run) `POST /api/hermes/cron/current-session` is unavailable; the profile token is never
  a fallback.
- **Admission.** `POST /api/hermes/cron/current-session` with `kind: "cron_job"` (`name`,
  `schedule`, `prompt`: native create paused and local, bind, resume),
  `"cron_session_binding"` + `job_id` (an unbound agent job; a bound one is refused
  `job_already_bound`), or `"script_report_enrollment"` (`mode` new or existing, as above). The
  destination is the authority's session, or an optional `target_session_id`: another session of the
  same account and profile, validated exactly like a consent target (unknown, deleted, unattributed,
  foreign-account or other-profile targets are refused before any native call) and frozen with its
  generation and owner. The authority stays the origin session. `session_id`, `context_id`, account,
  generation or `deliver` fields are refused (`destination_override_refused`). The origin (live
  execution, policy epoch, access, generation) and the target are rechecked after every native await
  before binding or resume. An existing agent or script job is paused and must be quiescent (no
  claimed or running execution) before it is bound, and is resumed only if it was scheduled; a job
  with an external `failure_deliver` lane is refused. Creation is not atomic: a failure after
  creation, or an uncertain resume, leaves the job paused (verified by reading it back) and reports
  its `job_id`.
- **Model-free setup.** `POST /api/hermes/cron/current-session/dispatch` (login only,
  `{ profile, session_id, kind, ..., optional target_session_id }`) runs the same admission once, for a session the caller can
  use, through a bounded Bridge worker that calls the managed API tool natively — no agent, no model
  request. Its authority is single use and ends with the run.
- **Delivery and revocation.** Bindings record the creating epoch, and a cross-session binding also
  its target's owner. Delivery (observer, script import and live publication) continues only while
  that epoch is the enabled one, the account keeps access and a cross-session target keeps that owner;
  a trusted binding observes only executions claimed from its binding instant on; restoring access resumes it, re-enabling the policy does not (new epoch). Disabling
  stops capture of policy-created script bindings (their native jobs keep running and the wrapper
  passes through) and policy-created agent results are recorded as `policy_revoked`; established
  native jobs are not paused, so agent jobs keep using their model locally until the user pauses or
  removes them. Consent and direct bindings are unaffected. A session reset or deletion ends
  delivery as usual; notices accepted earlier remain history.

## Terminal completions

The bridge previously re-queued every non-delegation event, so `notify_on_complete`
completions never reached Studio. Now `poll_background` does the following:

- It drains owned `type=completion` events with Hermes' own
  `process_registry.drain_notifications(skip_poll_observed=False)`. Watch and heartbeat
  events are unchanged.
- It returns each one as `process_notifications[]` with the producer key
  `hermes-process:<profile>:<process id>:<started_at>`.
- It recovers the native immediate-exit race from the live process record. The terminal
  tool flags the record after spawning, so a process that exits first gets no event.
  Such a record is republished once through the registry's publisher, and duplicates
  of the same key are dropped.
- It reports sessions with live `notify_on_complete` processes or pending watchers
  (`notify_pending`), which keeps Studio polling. A watcher whose process has exited and
  been settled no longer counts, so idle polling stops. An immediate exit still waiting
  for its one-second recovery grace counts until it is republished, emitted or consumed,
  so Studio keeps polling long enough to recover it.
- Each event carries the owner session generation that was current when the process
  started (`owner_generation`). The bridge keeps a short history of generation changes;
  repeated declarations of an unchanged generation are coalesced, so any number of
  ordinary turns keeps a live process's owner.

Studio accepts the event once (`admitting`) and queues a typed `machineEvent` run behind
any busy turn. Before queueing, after the awaited admission, and again at the final run
seam (before the user turn is stored and immediately before the model call) it checks:

- the owner session still exists with the same profile (`owner_missing`);
- its generation still equals the producer's (`owner_reset`; a missing generation fails
  closed);
- the user has not pressed Stop, and the run still owns the session: admission gives it a
  run marker and a machine ownership token. Stop and `/destroy` revoke the token
  synchronously, before their first await, and a new turn replaces the marker, so the run
  ends (`owner_stopped`) even though the generation is unchanged and even if a later turn
  resets the working or stop flags. A run that lost ownership never claims or changes the
  session state of the run that replaced it. Ordinary runs keep their own Stop handling.
  `/destroy` captures the owner it destroys (the state object and its owner revision) before
  its interrupt, bridge-destroy and usage awaits. Every accepted run owner (a claimed turn, a
  dequeued item, a machine or background claim, a reattached run, the turn an expanded
  command such as `/plan` or `/moa` starts) and every Stop advances
  that revision synchronously; queueing behind a busy owner does not. If a new owner
  appears meanwhile, even one still preparing without a run marker,
  `/destroy` still reports its result once but leaves that turn's bridge agent, state and
  queue alone;
- Hermes has not seen the result consumed by `wait` or `log` since the drain
  (`process_notification_admit`). A plain `poll` is not consumption.

Only then does the run start (`admitted`, then `dispatched` at the model call). If the
Agent Bridge reports itself not ready after admission, the event is settled as
`bridge_unavailable` (it is not retried) and the session is released only if the machine run
still owns it, so the next turn runs normally. Stop,
history clear and explicit queue cancel settle any queued machine event: the bridge
claim is completed (never re-queued) and the disposition becomes `cancelled`. It is stored as the model's user turn and displayed as a
system notice. A crash between admission and dispatch leaves `unknown` and never
re-dispatches. Notifications that Hermes has not handed off are lost if the bridge
worker dies (Hermes keeps them in memory only).

## External notices (HTTP)

An authenticated service, such as a validation or review job, can append a passive notice
to one existing Studio Hermes chat. Arrival never starts or queues a turn;
`POST /api/studio/chat-run/runs` remains the API for active input.

**Targets.** Version 1 accepts ordinary, locally stored Hermes bridge chats only (source
`cli`, legacy `api_server` or empty, Hermes agent). Ekko, coding-agent, workflow, group chat,
global agent, person and worker sessions return `422 unsupported_notification_target`.

**Credential.** Send a Studio login token (the `token` returned by `POST /api/auth/login`)
in the `Authorization: Bearer` header. Login tokens carry a signed `purpose: "login"` claim,
and only those are accepted here. Tokens Studio issues to model runs (`purpose: "model_run"`),
App device tokens, query-string tokens, share links, model API keys, the server token and
run-scoped credentials are refused. A token issued before login tokens carried a purpose is
refused by this endpoint only; sign in again once to get one. Other endpoints keep accepting
every existing token. The `exp` claim is authoritative: 30 days by default, configured by
`HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN`. The account must be active and have access to the
profile. There is no renewal: after expiry the operator supplies a new login token, and the
producer retries the same `event_id` with the same frozen generation.

**Freezing the target.** `GET /api/studio/sessions/{id}?profile=<profile>` returns
`session.session_generation`. Store it when the destination is chosen. A history reset or a
delete and same-id recreation changes it, and a stale value returns
`409 session_generation_mismatch` without writing anything. Choose the destination again
deliberately; never refetch the generation automatically after a failure.

```bash
curl -X POST "http://127.0.0.1:8648/api/studio/sessions/<session-id>/notifications" \
  -H "Authorization: Bearer <studio-login-token>" \
  -H "Content-Type: application/json" \
  -d '{"profile":"default","expected_session_generation":"<frozen-generation>",
       "source":"validator-review","event_id":"review-2026-10-30-1729",
       "title":"Validation complete","content":"All required checks passed.",
       "url":"https://example.org/reviews/1729"}'
```

| Field | Rule |
| --- | --- |
| `profile` | Required. Must be the session's profile and match any `x-hermes-profile` header or `profile` query |
| `expected_session_generation` | Required, the frozen generation |
| `source` | Required, at most 64 visible ASCII characters. A label chosen by the caller, not a verified identity |
| `event_id` | Required, at most 128 visible ASCII characters. Stable per producer event |
| `title` | Required, single line, at most 200 characters |
| `content` | Required plain text, at most 32 KiB of UTF-8 |
| `url` | Optional absolute `http(s)` link without credentials, at most 2,048 characters |

Other fields are rejected. The JSON body is limited to 64 KiB before the general request
parser reads it. Accepted values are stored exactly; nothing is truncated.

| Result | Status |
| --- | --- |
| New notice | `201` with `{ ok, notification_id, session_id, profile, session_generation, duplicate: false }` |
| Identical retry | `200` with the original receipt and `duplicate: true` |
| Stale generation / same identity, different content | `409 session_generation_mismatch` / `409 notification_conflict` |
| Unsupported session | `422 unsupported_notification_target` |
| Missing or invalid credential / valid credential that is not a login token | `401` / `403 login_token_required` |
| Unknown session, other profile or another user's private session | `404` |
| Invalid field / body too large / not JSON | `400` / `413` / `415` |

**Idempotency.** A notice is identified by Studio instance, profile, account, session,
generation, `source` and `event_id`. The generation is checked first, so an old receipt never
reports delivery to a reset or recreated session. An identical retry adds no timeline entry,
attention, live publication or context, and does not re-arm a notice that was already read
or projected. Changed `title`, `content` or `url` never overwrites the accepted notice.

**Display, delivery and context.** The notice shows its title, the unverified source label,
the content as plain text (never Markdown, HTML, images or file previews) and the link, which
opens only when clicked. Only a new acceptance is published live, after commit and only while
its generation is current; each recipient is re-checked against the current account (active,
role, profile access) and share state rather than state cached on its socket. The once-only
projection uses the same three-notice, 8,000-character block as cron results, quoting external
fields as untrusted JSON-string data. Studio and native Hermes history keep the user's own
question, not the projected text, for every notice-projected turn.

## Verification

```bash
npx vitest run tests/server/session-notifications-cron.test.ts tests/server/session-notifications-external.test.ts \
  tests/server/script-report-wrapper.test.ts tests/server/script-report-import.test.ts tests/server/script-report-enrollment.test.ts \
  tests/server/cron-session-bindings.test.ts tests/server/cron-consent.test.ts \
  tests/client/cron-consent-card.test.ts
HERMES_REAL_BRIDGE_E2E=1 HERMES_AGENT_ROOT=<read-only hermes checkout> \
  npx vitest run tests/server/hermes-session-notifications-real.test.ts
npm run build && HERMES_AGENT_ROOT=<read-only hermes checkout> \
  node tests/server/fixtures/session-notifications-e2e.mjs
npm run build && HERMES_AGENT_ROOT=<read-only hermes checkout> node tests/server/fixtures/script-reports-e2e.mjs
# Consent journey for both job types: real MCP issuer, browser click, native scheduler.
npm run build && HERMES_AGENT_ROOT=<read-only hermes checkout> E2E_CHROMIUM=<chromium binary> \
  node tests/server/fixtures/cron-consent-e2e.mjs
```

The real harnesses use disposable `HOME`, `HERMES_HOME`, Web UI home and `TMPDIR`, a
scripted local model, `PYTHONDONTWRITEBYTECODE=1` and `HERMES_DISABLE_LAZY_INSTALLS=1`,
so the Hermes checkout is only read. The end-to-end script also runs a foreground
`hermes gateway run` in the temp home, which provides the cron ticker.
