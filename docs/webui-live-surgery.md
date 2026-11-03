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
base64 characters each (3.75 MB, within the per-image limit Claude's vision
docs give, 5 MB of base64 on Bedrock and Google Cloud and 10 MB on the
Anthropic API: https://platform.claude.com/docs/en/build-with-claude/vision), 12 MiB of
base64 image data per message
(about 9 MiB of image files), leaving room for its text, and 8000 px on a
side, the most those docs give for one image. A whole message, text and images, travels in one WebSocket frame of
at most 16 MiB (`MAX_WS_FRAME_BYTES`, the host's
`maxPayloadLength`). The host closes a socket that sends a larger frame,
with no refusal, so the composer measures each message's frame first and
keeps one that's over, with a note, to shorten. The browser fits an image
to the image limits before sending: one that already fits goes byte for
byte; one too big, too large on a side, or in a format the model APIs
don't take (BMP, SVG, …) is redrawn smaller as WebP (JPEG on white, which
flattens any transparency, where the browser can't write WebP), and its
thumbnail says so. A size the browser can't draw at is tried smaller. An
animation is redrawn as one still frame, the one a canvas draws (its default
image, else its first frame), and shows "still frame": Claude's docs say only
the first frame is used, and OpenAI's list only non-animated GIF. A host whose recipe uses `openai-responses` or
`openai-codex` refuses an animated GIF, WebP or PNG from any client. A PNG,
JPEG, GIF or WebP that is cut short, or a PNG with a chunk that
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
have reached the host, until an echo replaces it. Shown in another session
than it was sent in, the mark names that session and its branch, and in
another branch of the same session, that branch. Only `/clear`, or a reload
of the page, drops them. A routed message's row gives way, since no echo of
it comes here. A host from before the `corrId` on entries, as under
`bun run dev` against an older running host, shows each send twice until a
reload, and after a reconnect marks this client's copy not confirmed beside
the stored one.

Images can't go to a fleet child (`@name …`) or with a slash command; the
composer says so and keeps the draft. Once sent, the context manager's
live-image limits (`maxLiveImages`, `imageStripDepthTokens`,
`maxLiveImageBytes`) apply to them like any other image.

A message is refused when it would come near `imageStripDepthTokens`
(default 30 000) as soon as it is stored, since past it its images could
reach the model only as a placeholder. When a single image would come that
near on its own, the refusal says the depth leaves too little room for an
image, which whoever runs the host can raise; when the text leaves no room
for even one image, or the text takes it there, it asks for the images
first, in a message of their own, then the text once the agent has answered
them; when the number of its images does, it says how many fit, with the
text if there is any, and asks for the rest to be attached again after, at
most as many as fit alone at a time; and when both do, it says how many fit
on their own, sent first, with the text after in a message of its own, and
the rest attached again after that, as many at a time. Each later part waits
for the agent's answer to the part before, since a part stored before the
agent next compiles counts toward the depth of the images ahead of it. Sent
after the images, the text can be read once they have gone to placeholders,
with the model's own reply to them before it: the images first is the order
the composer can follow without losing them, since it sends every attachment
with its draft. The line is the context manager's own token estimate of the
message, as it stores it, at the calibration of the agent's last compile,
and the host refuses past 90% of the depth. It is an estimate at send time:
a calibration change from a provider reply, or messages stored after it,
before the message's first compile can still put its images past the depth.
A recipe whose `imageStripDepthTokens` is 0 has no depth to check.

By Claude's vision docs
(https://platform.claude.com/docs/en/build-with-claude/vision), a request
carrying more than 20 images meets a stricter per-image dimension limit than
8000 px, and every image in it counts: earlier turns' images and those in
tool results too. Where that limit is enforced, an image over it fails every
request that carries it alongside 20 others, so the agent is stuck until the
image leaves the live window. The docs don't give the stricter limit's
value, which a refusal states; they give 2000 px on a side as under it on
every platform. Probes on 2026-10-13 and 2026-10-19 found the Anthropic API
accepting 21 and 101 images with one of them at 2100 px, so its own limit
may be higher, and the host follows the docs' bound for every platform
regardless. With the default `maxLiveImages` of 6 no request gets there. A
host whose recipe can keep more than 20 images live (`maxLiveImages` past 20
or set to 0, or a strategy an extension registers) holds composer images to
2000 px on a side. A message also takes no more images than the live window
keeps, since the rest would never reach the model.

A host whose recipe uses `passthrough` doesn't take composer images: it
keeps every image in every request, so a few large ones would carry each
request past the most membrane sends (28 MiB), and every inference after
would fail. Its Web UI offers no attaching, and the host refuses a message
that carries images.

## Operator log

`<storePath>/operator-actions.jsonl` (`DATA_DIR/sessions/<id>/`) — one JSON
line per operator mutation:
`at, kind, agent, requester{via,name}, note, params, result | error`. Kinds:
`rollback`, `suppress`, `hide`, `undo-turn`, `redo-turn`, `unstick`, `nudge`,
`settings-update`, `settings-reset`, `settings-cancel-transition`,
`quiesce`, `resume`. Refusals are logged too (with `error`), except a
change refused before it reaches its handler: one sent during a session
switch, or one chosen in a session other than the one whose framework is
open. The branch
panel shows the tail and refreshes on `operator:action` traces. The
chronicle record log remains the authoritative history of *what* changed;
this file records *who/where/why*.

Requester identity from the WebUI is the basic-auth username (`via:
'webui'`) or the observer grant label (`via: 'webui-observer'`; observers
cannot mutate, so they only appear for read requests that fail).

## Wire additions

Client → server: `rollback {messageId, sessionId, agent?, note?}`, `suppress
{messageIds, sessionId, agent?, note?}`, `host-quiesce {reason?}`, `host-resume`,
`request-host-mode`, `request-operator-log {limit?}`.
Server → client: `surgery-result`, `host-mode`, `operator-log`;
`welcome.features`, `welcome.hostMode`. `sessionId` is the session whose
messages the operator chose from, as the server stamped it on them: the
welcome's `session` for the transcript, and the `/debug/context` answer's
`sessionId` for the Context view, each the session whose framework produced
them. A rollback or suppress chosen in a session other than the one whose
framework is open is answered `ok: false`, saying nothing changed. After a successful surgery the
server does what `/checkout` does: `branch-changed` to every client whose
scopes hold `messages`, and a fresh welcome for every client, as its scopes
allow.
