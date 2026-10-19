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
becomes the current branch, `_config` is re-materialized, and Discord
messages that left the context get the awareness marker through the durable
outbox exactly as `/undo` does. Nothing is deleted.

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
proxies to a fleet child via the `media` panel op). A coalesced shard run's
images carry refs that name the shard each is stored in, since the run's own
block indices are its own.

The Context document already receives the compiled request with base64
inline (it *is* what the model sees), so it renders those directly; the
stripped-image placeholder text stays visible where the strategy dropped one.

### Sending images

The composer takes images from the `+ img` picker, a paste, or a drop onto
it, shown as thumbnails until the message is sent. They ride in the
`user-message` frame as `images: [{mediaType, data}]` (raw base64) and are
stored as image blocks ahead of the message's text. The host advertises the
`user-images` feature; the SPA offers attaching only when it does, since an
older host ignores the field.

Limits (`USER_IMAGE_LIMITS` in `src/web/protocol.ts`): 8 images, 5,000,000
base64 characters each (3.75 MB, within the per-image limit on Bedrock and
Google Cloud, 5 MB of base64, and on the Anthropic API, 10 MB), 12 MiB of
base64 image data per message
(about 9 MiB of image files), leaving room for its text, and 8000 px on a
side. A whole message, text and images, travels in one WebSocket frame of
at most 16 MiB (`MAX_WS_FRAME_BYTES`, the host's
`maxPayloadLength`). The host closes a socket that sends a larger frame,
with no refusal, so the composer measures each message's frame first and
keeps one that's over, with a note, to shorten. The browser fits an image
to the image limits before sending: one that already fits goes byte for
byte; one too big, too large on a side, or in a format the model APIs
don't take (BMP, SVG, …) is redrawn smaller as WebP (JPEG on white, which
flattens any transparency, where the browser can't write WebP), and its
thumbnail says so. A size the browser can't draw at is tried smaller. An
animation sent as it is shows "first frame", since the model APIs use only
that. A PNG, JPEG, GIF or WebP that is cut short, or a PNG with a chunk that
fails its checksum, is refused rather than redrawn, since the browser would
draw only what it has.
The host checks again for every client, telling the format by the bytes (a
mislabeled type is corrected) and walking the file to its end marker (PNG
chunks are checksummed too; a JPEG's, GIF's or WebP's compressed data has no
checksum, so damage inside it would take a decoder to see), and refuses a
message whose image fails with `message not sent: <reason>`. A stored image the
API refuses would fail every later inference on the branch until it leaves the
live window, so the host refuses what these checks can see: the format, a file
cut short, a damaged PNG, the size and the dimensions. Damage inside compressed
data, which they can't see, can still be stored. The limits are the host's
own, from its recipe, and its welcome advertises them for the composer to fit
to. The refusal carries the send's `corrId`: when the composer is empty (no
text, no images, none still being read), the message goes back into it and its
row comes out of the transcript; with a draft there, the row stays, marked not
sent with the host's reason. The stored message's entry carries the `corrId`
too, so its echo replaces exactly the row its send showed, and a history page
holding it settles the row the same way. A message the socket doesn't take,
while it isn't open, stays in the composer with a note. Whenever a welcome
replaces the transcript, after a reconnect or a change of session or branch, a
send typed here that its window doesn't hold stays after it: a refused one
with its mark, and any other marked not confirmed, since its message may not
have reached the host, until an echo replaces it. After a change of session or
branch, the mark names the one it was sent in. Only `/clear` drops them. A
routed message's row gives way, since no echo of it comes here. A host from
before the `corrId` on entries, as under `bun run dev` against an older
running host, shows each send twice until a reload.

Images can't go to a fleet child (`@name …`) or with a slash command; the
composer says so and keeps the draft. Once sent, the context manager's
live-image limits (`maxLiveImages`, `imageStripDepthTokens`,
`maxLiveImageBytes`) apply to them like any other image.

By the model API's docs, a request carrying more than 20 images meets a
stricter per-image dimension limit than 8000 px, and every image in it
counts: earlier turns' images and those in tool results too. Where that
limit is enforced, an image over it fails every request that carries it
alongside 20 others, so the agent is stuck until the image leaves the live
window. Probes on 2026-10-13 and 2026-10-19 found the API accepting such
requests; the host follows the docs regardless. With the default
`maxLiveImages` of 6 no request gets there. A host whose recipe can keep more
than 20 images live (`maxLiveImages` past 20 or set to 0, `passthrough`,
which keeps every image, or a strategy an extension registers) holds
composer images to 2000 px on a side, which the model API's docs give as
under that limit on every platform. A message also takes no more images than
the live window keeps, since the rest would never reach the model.

## Operator log

`<storePath>/operator-actions.jsonl` (`DATA_DIR/sessions/<id>/`) — one JSON
line per operator mutation:
`at, kind, agent, requester{via,name}, note, params, result | error`. Kinds:
`rollback`, `suppress`, `hide`, `undo-turn`, `redo-turn`, `unstick`, `nudge`,
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
Server → client: `surgery-result`, `host-mode`, `operator-log`;
`welcome.features`, `welcome.hostMode`. After a successful surgery the
server does what `/checkout` does: `branch-changed` + a fresh welcome for
every client.
