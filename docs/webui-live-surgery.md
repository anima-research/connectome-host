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

What happens (`framework.rollbackToMessage`): the chronicle is forked
(`branchAt`) at that message's origin sequence, or, on a presented window, at
the sequence of the presentation write that showed it (below). The fork,
`rollback/<agent>/<ts>`, becomes the current branch, and `_config` is
re-materialized. Nothing is deleted. Discord messages that left the context are not marked: agent-framework
makes marking a separate, explicit choice (`rollbackToMessage`'s `marks`,
default `none`), and the WebUI's rollback doesn't make it (an undo, which acts
on the window only, marks none either).

On a presented window (agent-framework #291) the cut is at the write that
showed the agent the message, so some rows after it can stay, and the result
says how many: rows that one write showed together with the message stay in
the agent's context after it (`keptInWindowAfterTarget`; suppress them, or
hide them by Discord message id), and rows stored before the message was
shown and shown after it stay in the record, out of the context until the
agent's next turn starts, or the host restarts before then
(`returnedToArrivals`). Neither is counted in
`messagesRemoved` or marked. A row another resident stored after the
message and before that write stays on the new branch too, and is in
neither count, since it isn't the agent's: the record holds every
resident's rows, and the cut is by sequence.

The framework refuses while the agent is not idle (`agent-busy`); nothing is
queued. The dialog then offers **Quiesce, then retry**.

## Suppress messages

The row's **⊘ suppress** enters selection mode; tick more rows; the floating
bar's **suppress** opens the confirm. `framework.suppressMessages` forks at the
current head (`suppress/<agent>/<ts>`), redacts the selected messages on the
fork newest-to-oldest (a shard of a body group expands to the whole group —
chronicle refuses to bisect one), and switches. If any removal fails the
agent is put back on the untouched source branch.

On a presented window (agent-framework #291) the removal reaches what every
reader on the store folded: each agent's strategy drops each summary that
folded a removed message, and folds the rows it keeps again. In legacy mode it
is not retroactive over derived state: a message already folded into an
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
docs give everywhere the model is served, the strictest being Bedrock's 5 MB
of base64: https://platform.claude.com/docs/en/build-with-claude/vision), 12 MiB of
base64 image data per message
(about 9 MiB of image files), leaving room for its text, and 3,000 px on a
side (below). A whole message, text and images, travels in one WebSocket frame of
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
text, no images, none still being read), the message goes back into it, with
a note giving the host's reason, and its row comes out of the transcript; with
a draft there, the row stays, marked not sent with the host's reason. The
stored message's entry carries the `corrId` too, so its echo replaces exactly the row its send showed, and a history page
holding it settles the row the same way. A message the socket doesn't take,
while it isn't open, stays in the composer with a note. Whenever a welcome
replaces the transcript, after a reconnect or a change of session or branch, a
send typed here that its window doesn't hold stays after it: a refused one
with its mark, and any other marked not confirmed, since its message may not
have reached the host, until an echo replaces it. Shown in another session
than it was sent in, the mark names that session and its branch, and in
another branch of the same session, that branch. A welcome in a protocol this
client doesn't speak marks every send not yet echoed not confirmed, so it's
plain, before the reload its banner asks for, which sends that reload drops. Only `/clear`, or a reload of the page,
drops them. A routed message's row gives way, since no echo of
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
reach the model only as a placeholder. The refusal asks for fewer images,
or less text with them, and for the rest once the agent has answered,
since a part stored before the agent next compiles counts toward the depth
of the images ahead of it. When a single image would come that near on its
own, it says instead that the depth leaves too little room for an image,
which whoever runs the host can raise. The line is the context manager's
own token estimate of the message, as it stores it, at the calibration of
the agent's last compile, and the host refuses past 90% of the depth. It is
an estimate at send time: a calibration change from a provider reply, or
messages stored after it, before the message's first compile can still put
its images past the depth.
A recipe whose `imageStripDepthTokens` is 0 has no depth to check.

Every host holds composer images to 3,000 px on a side, whatever its
provider. A stored image goes with every later request while it stays in the
live window, to whichever provider the recipe names then, so the side has to be
one Claude's and OpenAI's APIs take in any request:
- By Claude's vision docs
  (https://platform.claude.com/docs/en/build-with-claude/vision), a request
  with more than 20 image blocks holds every image in it to a stricter limit,
  and 3,000 px on a side stays under it on every platform. Earlier turns'
  images and those in tool results count, and on Amazon Bedrock and Claude
  Models on Google Cloud so do document blocks. The live window bounds its
  own images, but not documents, images a module adds outside it, or what a
  strategy an extension registers keeps, so the host can't know when a
  request passes 20.
- By OpenAI's (https://developers.openai.com/api/docs/guides/images-vision),
  its newest models keep an image's own size at the default detail and
  refuse an image that needs more than 30,000 patches of 32 px. A 3,000 px
  square needs 8,836.

An image over OpenAI's limit fails every request that carries it, and one
over Claude's stricter limit every request that carries it with more than 20
image blocks, so the agent is stuck until the image leaves the live window. Claude scales an image to at
most 2,576 px on its longer side before reading it, so the ceiling takes
nothing from it.

Under the host's own strategies, `autobiographical` and `frontdesk`, a message
also takes no more images than the live window keeps, and, where the recipe
sets `maxLiveImageBytes`, no more base64, since the rest would never reach
the model. A strategy an extension registers gets the defaults, since the
host can't read its window.

A host whose recipe uses `passthrough` doesn't take composer images: it
keeps every image in every request, so a few large ones would carry each
request past the most membrane sends (28 MiB), and every inference after
would fail. Its Web UI offers no attaching, and the host refuses a message
that carries images.

## Operator log

`<storePath>/operator-actions.jsonl` (`DATA_DIR/sessions/<id>/`) — one JSON
line per operator mutation:
`at, kind, agent, requester{via,name}, note, params, result | error`. Kinds:
`rollback`, `suppress`, `checkout` (a host's `/checkout`, `/restore` to a
branch head, or a switch over the framework's API), `hide`, `undo-turn`,
`redo-turn`, `unstick`, `nudge`,
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
`request-host-mode`, `request-operator-log {limit?}`, and `user-message`'s
`images` and `corrId`.
Server → client: `surgery-result` (with `returnedToArrivals` and
`keptInWindowAfterTarget` when a rollback kept rows), `host-mode`,
`operator-log`, `undone-marks`; `welcome.features`, `welcome.hostMode`,
`welcome.userImageLimits`; and a stored user message's entry carries its
send's `corrId`.
`sessionId` is the session whose messages the operator chose from, as the
server stamped it on them: the welcome's `session` for the transcript, and
the `/debug/context` answer's `sessionId` for the Context view, each the
session whose framework produced them. A rollback or suppress chosen in a
session other than the one whose framework is open is answered `ok: false`,
saying nothing changed. After a successful surgery the server does what
`/checkout` does: `branch-changed` to every client whose scopes hold
`messages`, and a fresh welcome for every client, as its scopes allow.

An undo or a redo on the conversation agent's window (`/undo`, `/redo`, the
`window:undone` trace) moves no branch, and the transcript still shows the
record. A transcript entry whose row is out of the window as an undone
turn's carries `undone: true` (the welcome, history pages): an undo (which
`/redo` can put back until the agent's next turn, a branch move or a restart;
agent-framework keeps the redo in memory only) or a shed
after a refusal or failed inference (which it doesn't) takes rows out that
way. After each `window:undone` trace, and
each shed from that window (`presentation:retracted`, reason `shed`), the
server sends `undone-marks` (scope `messages`) naming every undone row of
the record, from index 0, which the page dims and labels wherever it holds
them, clearing the label of each row it holds that the frame doesn't name.
The page also reads the
window's panels again (Context's makeup and coverage, the compiled context
document, the pins). The server sends the frame right after each welcome
too, since a welcome marks only its tail and a page keeps its older rows
across a reconnect to the same branch; that one reads no panel. The pin
picker lists the server's candidates, the record's last 200 rows less the
undone ones and those whose audience stamp leaves the agent out (another
resident's on a shared store), or, on a legacy window, which reads no
stamp, less the rows the resident's view leaves out instead (held traffic,
suppressed rows, another agent's stored injections).
