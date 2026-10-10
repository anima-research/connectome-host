# WebUI live surgery: rollback, suppression, quiesce, images, operator log

Operator mutations of a **running** resident, from the WebUI, without a
restart. Everything here follows the idiom the offline surgeries use: fork
first, mutate the fork, make the fork the live branch. The parent branch
keeps everything, so "undo" is always `checkout <parent>`.

The agent-framework this host depends on (^0.21.0) provides all of it. The
SPA still feature-detects each affordance from `welcome.features`, so a
bundle against a host without them simply shows none.

## Rollback to a message

Chat view: hover a message → **⏪ roll back** (the row actions sit inside the
row, top-right). Context view: **⏪ roll back to here** on a raw (non-summary)
box, faintly visible until hovered (boxes carry `sourceMessageId`; summaries
do not, so they have no button).

What happens (`framework.rollbackToMessage`): the chronicle is forked at that
message's origin sequence (`branchAt`), the fork — `rollback/<agent>/<ts>` —
becomes the current branch, and `_config` is re-materialized. Nothing is
deleted. Whether the people whose Discord messages left the context see a
💤 is the operator's choice in the dialog (see [Discord awareness
marks](#discord-awareness-marks)); by default they don't.

The framework refuses while the agent is not idle (`agent-busy`); nothing is
queued. The dialog then offers **Quiesce, then retry**. That quiesce is
bound to the session and store the surgery was previewed on: if the dialog
has gone stale it isn't offered, and the server refuses a retry's quiesce
(nothing is paused) once the live session or the bound framework's store
is no longer the previewed one.

A surgery is never resent. If the connection is down, nothing is sent and
the dialog waits for it to come back; if it drops while a surgery is
pending, the result can't arrive, and the dialog says the outcome is
unknown (check the branch panel and the operator log) instead of waiting.

## Suppress messages

The row's **⊘ suppress** enters selection mode; tick more rows; the floating
bar's **suppress** opens the confirm. `framework.suppressMessages` forks at the
current head (`suppress/<agent>/<ts>`), redacts the selected messages on the
fork newest-to-oldest (a shard of a body group expands to the whole group —
chronicle refuses to bisect one), and switches. If any removal fails the
agent is put back on the untouched source branch.

Not retroactive over derived state: a message already folded into an
autobiographical summary stays in that summary. Roll back to before it
entered if that matters.

## Discord awareness marks

With an agent-framework that offers preview-bound surgery (feature `marks`:
it takes the marks choice, and it checks the previewed store and branch
itself), opening the rollback or suppress dialog asks the framework what the
change would remove (`surgery-preview`, read-only) and offers:

- **Don't mark** (the default): the change stays local to the agent.
- **Mark the N that addressed the agent**: removed messages tagged
  `chat:addressed` (mentions, replies to the bot, DMs).
- **Mark all N** removed Discord messages.

Each scope shows its count and channels. A chosen scope is sent with exactly
the refs the preview listed, so messages that arrive while the operator is
deciding are removed but never marked. One choice carries at most 20,000
refs: a larger scope is shown as unavailable with its size and is never
cut short, while no marks and any smaller scope stay available. Every live
surgery here is preview-bound: confirming waits for the preview (asked for
again when the connection comes back on the same session and branch, since
a request or answer can be lost with the old socket), and the confirmation
carries the framework's preview `context` (its store identity and branch),
which the framework checks under its own reservation before preparing or
changing anything. The host also checks the session and branch the dialog
opened on: if the host rebinds to another session or the branch changes,
the open dialog says so and can't be confirmed, and the server refuses a
confirmation whose session or branch is no longer the live one. Either
refusal is `code: 'stale'`. Ordinary arrivals on the same branch don't
affect it. The result shows the framework's
receipt: marks queued (and how many removed messages stay unmarked), not
scheduled, or unresolved. It never claims Discord accepted anything; delivery
runs in the background without holding the agent.

The branch panel lists the framework's awareness journal (feature
`awareness`): each surgery's batch of marks and each retract, with what is
known about their requests. **cancel** stops all further sends of a batch's
marks or a retract's removals and never removes anything; **retract** queues
removal of this bot's marks from a batch's messages (or from every message,
**retract all**) after asking, since it sends Discord requests; **release**
sends a batch the framework held at startup. Receipts are shown as returned:
requests without an answer may still land. An action reaches only the
framework whose journal it was chosen from: each listing carries an opaque
id the host mints for the framework instance it read, the action sends it
back, and the server refuses it (`code: 'stale'`, recorded in the operator
log) once another framework is bound, answering with the live journal. The
session label can't stand in for that id, since a session switch makes the
new session active before its framework replaces the old one. After a
session switch the panel drops the old journal and lists the new one.

An agent-framework without that contract can't carry out this operation, a
local change on the previewed store and branch plus an optional bounded
public act: an older one places 💤 on every removed Discord message it can
address and removes and re-adds those marks as branches switch, and one
with the marks choice but no store-and-branch check can't keep the change on
what was previewed. The server refuses every live rollback and suppression
there before anything changes (`code: 'unsupported'`), and the dialog
explains that the agent-framework needs upgrading.

## Quiesce / resume

Header switch (`● serving` / `⏸ quiesced`). Quiesce drains in-flight turns,
then holds every wake (MCPL data planes, heartbeat, timers) while
compression/maintenance keep running; resume re-runs the feasibility gate
and releases the barrier. Both are recorded in the operator log with the
reason you type. Transitions that originate elsewhere (Discord
`host/command`, API) reach the UI through `host:*` traces.

## Images

Transcript frames reduce media to `{kind:'media', mediaType, ref}`; the
browser renders `<img src="/media/<ref>">` lazily and opens a lightbox on
click. `ref` is `<messageId>/<blockIndex>` or `<messageId>/<blockIndex>.<inner>`
for an image nested in a tool result (read_image, cameras, screenshots).
The endpoint resolves that one message's blobs and streams bytes
(`image/*` only, `nosniff`, sandboxed CSP; observer sessions need the
`messages` scope; `?agent=<name>` picks a non-root agent; `?scope=<child>`
proxies to a fleet child via the `media` panel op). Coalesced shard runs carry
no refs (their block indices are synthetic) and keep the type chip.

The Context document already receives the compiled request with base64
inline (it *is* what the model sees), so it renders those directly; the
stripped-image placeholder text stays visible where the strategy dropped one.

## Operator log

`<storePath>/operator-actions.jsonl` (`DATA_DIR/sessions/<id>/`) — one JSON
line per operator mutation:
`at, kind, agent, requester{via,name}, note, params, result | error`. Kinds:
`rollback`, `suppress`, `hide`, `undo-turn`, `redo-turn`, `unstick`, `nudge`,
`settings-update`, `settings-reset`, `settings-cancel-transition`,
`quiesce`, `resume`, `awareness-cancel`, `awareness-retract`,
`awareness-release`. A surgery's `params.marks` records the marks choice.
Refusals are logged too (with `error`), including those the host makes
before the framework sees a request (a stale or unpreviewed surgery, one an
older framework can't carry out, a journal action chosen from another
framework's journal, a retry's quiesce for another session or store), in
the framework's own entry shape. The branch
panel shows the tail and refreshes on `operator:action` traces. The
chronicle record log remains the authoritative history of *what* changed;
this file records *who/where/why*.

Requester identity from the WebUI is the basic-auth username (`via:
'webui'`) or the observer grant label (`via: 'webui-observer'`; observers
cannot mutate, so they only appear for read requests that fail).

## Wire additions

Client → server: `rollback {messageId, agent?, note?, marks?,
expectedContext, expectedSessionId?, expectedBranchId?}`, `suppress
{messageIds, agent?, note?, marks?, expectedContext, expectedSessionId?,
expectedBranchId?}` (`marks`: `'none'` or `{scope: 'addressed' | 'all',
refs?}`; `expectedContext` is the preview's `context`, required, checked by
the framework; the expected ids are the session and branch the dialog was
opened on, checked by the host), `surgery-preview {op, messageId | messageIds,
agent?}`, `request-awareness`, `awareness-action {action: cancel | retract
| release, target, expectedFrameworkInstanceId}` (`target: 'all'` for
retract only; the id is the listing's `frameworkInstanceId`, required),
`host-quiesce {reason?, expectedSessionId?, expectedStoreId?}` (a retry's
quiesce sends its preview's session and `context.storeId`), `host-resume`,
`request-host-mode`, `request-operator-log {limit?}`.
Server → client: `surgery-result` (with `markers` on `marks` hosts),
`surgery-preview`, `awareness {batches, frameworkInstanceId, …}` (the
journal; also broadcast to full operators after a surgery whose marks were
queued or left unresolved, and after each action that succeeds; an action's
answer carries `code: 'stale'` when refused for another framework's
journal), `host-mode`,
`operator-log`; `welcome.features`, `welcome.hostMode`. After a successful
surgery the server does what `/checkout` does: `branch-changed` + a fresh
welcome for every client.
