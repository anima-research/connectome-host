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
queued. The dialog then offers **Quiesce, then retry**.

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

With an agent-framework that takes the choice (feature `marks`), opening the
rollback or suppress dialog asks the framework what the change would remove
(`surgery-preview`, read-only) and offers:

- **Don't mark** (the default): the change stays local to the agent.
- **Mark the N that addressed the agent**: removed messages tagged
  `chat:addressed` (mentions, replies to the bot, DMs).
- **Mark all N** removed Discord messages.

Each scope shows its count and channels. A chosen scope is sent with exactly
the refs the preview listed, so messages that arrive while the operator is
deciding are removed but never marked. The result shows the framework's
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
requests without an answer may still land.

An older agent-framework (no `marks` feature) places 💤 on every removed
Discord message it can address, and removes and re-adds those marks as
branches switch; it can't be told not to. Default none still holds at this
ingress: the server refuses such a surgery unless the request carries
`legacyMarks: true`, the operator's explicit acceptance of those marks
(omitted marks and `'none'` are refused alike), and it refuses a scope or
refs, which that framework can't honor. The dialog explains this and keeps
its confirm button disabled until the operator ticks the acceptance.

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
`awareness-release`. A surgery's `params.marks` records the marks choice. Refusals are logged too (with `error`). The branch
panel shows the tail and refreshes on `operator:action` traces. The
chronicle record log remains the authoritative history of *what* changed;
this file records *who/where/why*.

Requester identity from the WebUI is the basic-auth username (`via:
'webui'`) or the observer grant label (`via: 'webui-observer'`; observers
cannot mutate, so they only appear for read requests that fail).

## Wire additions

Client → server: `rollback {messageId, agent?, note?, marks?, legacyMarks?}`,
`suppress {messageIds, agent?, note?, marks?, legacyMarks?}` (`marks`:
`'none'` or `{scope: 'addressed' | 'all', refs?}`; `legacyMarks: true` only
for a framework without `marks`), `surgery-preview {op, messageId | messageIds,
agent?}`, `request-awareness`, `awareness-action {action: cancel | retract
| release, target}` (`target: 'all'` for retract only), `host-quiesce
{reason?}`, `host-resume`, `request-host-mode`, `request-operator-log
{limit?}`.
Server → client: `surgery-result` (with `markers` on `marks` hosts),
`surgery-preview`, `awareness` (the journal; also broadcast to operators
after a surgery that queued marks and after each action), `host-mode`,
`operator-log`; `welcome.features`, `welcome.hostMode`. After a successful
surgery the server does what `/checkout` does: `branch-changed` + a fresh
welcome for every client.
