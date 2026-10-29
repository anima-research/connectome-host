# WebUI live surgery: rollback, suppression, quiesce, images, operator log

Operator mutations of a **running** resident, from the WebUI, without a
restart. Everything here follows the idiom the offline surgeries use: fork
first, mutate the fork, make the fork the live branch. The parent branch
keeps everything, so "undo" is always `checkout <parent>`.

Every agent-framework this host can install provides all of it. The
SPA still feature-detects each affordance from `welcome.features`, so a
bundle against a host without them simply shows none.

## Rollback to a message

Chat view: hover a message → **⏪ roll back** (the row actions sit inside the
row, top-right). Context view: **⏪ roll back to here** on a raw (non-summary)
box, faintly visible until hovered (boxes carry `sourceMessageId`; summaries
do not, so they have no button).

What happens (`framework.rollbackToMessage`): the chronicle is forked at that
message's origin sequence (`branchAt`), the fork — `rollback/<agent>/<ts>` —
becomes the current branch, `_config` is re-materialized, and Discord
messages that left the context get the awareness marker through the durable
outbox exactly as `/undo` does. Nothing is deleted.

On a presented window (agent-framework #291) the cut is at the write that
showed the agent the message, so some rows after it can stay, and the result
says how many: rows that one write showed together with the message stay in
the agent's context after it (`keptInWindowAfterTarget`; suppress them, or
hide them by Discord message id), and rows stored before the message was
shown and shown after it stay in the record, out of the context until the
agent's next turn starts (`returnedToArrivals`). Neither is counted in
`messagesRemoved` or marked.

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
`rollback`, `suppress`, `checkout` (a host's `/checkout`, `/restore` to a
branch head, or a switch over the framework's API), `hide`, `undo-turn`,
`redo-turn`, `unstick`, `nudge`,
`settings-update`, `settings-reset`, `settings-cancel-transition`,
`quiesce`, `resume`. Refusals are logged too (with `error`). The branch
panel shows the tail and refreshes on `operator:action` traces. The
chronicle record log remains the authoritative history of *what* changed;
this file records *who/where/why*.

Requester identity from the WebUI is the basic-auth username (`via:
'webui'`) or the observer grant label (`via: 'webui-observer'`; observers
cannot mutate, so they only appear for read requests that fail).

## Wire additions

Client → server: `rollback {messageId, agent?, note?}`, `suppress
{messageIds, agent?, note?}`, `host-quiesce {reason?}`, `host-resume`,
`request-host-mode`, `request-operator-log {limit?}`.
Server → client: `surgery-result` (with `returnedToArrivals` and
`keptInWindowAfterTarget` when a rollback kept rows), `host-mode`,
`operator-log`, `undone-marks`; `welcome.features`, `welcome.hostMode`.
After a successful surgery the server does what `/checkout` does:
`branch-changed` to every client whose scopes hold `messages`, and a fresh
welcome for every client, as its scopes allow.

An undo or a redo on the conversation agent's window (`/undo`, `/redo`, the
`window:undone` trace) moves no branch, and the transcript still shows the
record. A transcript entry whose row left the window by an undo carries
`undone: true` (the welcome, history pages), and after each such trace, and
each shed from that window (`presentation:retracted`, reason `shed`), the
server sends `undone-marks` (scope `messages`) naming every undone row of
the record, from index 0, which the page dims and labels wherever it holds
them, clearing the label of each row it holds that the frame doesn't name.
The page also reads the
window's panels again (Context's makeup and coverage, the compiled context
document, the pins), and the pin picker leaves undone rows out.
