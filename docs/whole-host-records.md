# Whole-host records

`test/whole-host/` runs this host against a stand-in for Anthropic's API,
through a set of workload runs, and keeps one record per run in
`test/whole-host/records/`. Each run's recipe loads the host's context
strategy and the fixture's own MCPL server. It turns off the subagents
module (H2's configuration and W9's workload turn it back on), the lessons, retrieval, wake and workspace
modules, cache keepalive and the context maintenance timer (`driver.mjs`'s
recipe, `script.mjs`'s configurations). A record says what every request the
run sent carried. A change that moves what those requests carry changes the
records, and their diff in the pull request is what to read.

## Running it

`npm run test:whole-host` runs every run, judges it, and compares each run's
record with the committed one. It exits 0 when every run passed and every
record matched, 1 when a run flagged something or a record differs, and 2
when a run couldn't run. A run whose `report.txt` can't be written ends the
invocation there, as an uncaught error, which exits 1.

- `--runs A,B` runs only those (`CONFIGURATION/WORKLOAD[/VARIANT]`, as
  `workloads.mjs` `RUNS` lists them).
- `--update-records` writes each run's record over the committed one. Use it
  once the change a diff shows is the change you mean. It rewrites
  `records/versions.txt` only when it ran and updated every run, so that file
  names the stack of the last invocation that updated every record. A record
  updated alone under another stack wasn't made with the stack it names, and
  under that stack the file's comparison fails until every run is updated.
- `--overlay PACK.tgz` lays a packed agent-framework, context-manager,
  membrane or chronicle over this checkout's install, to see what a change to
  one of them does here. A host change is a change to this checkout itself.
- `--checkpoints DIR` keeps the runs' starting checkpoints in `DIR` between
  invocations, keyed by the lane, the release's versions, the run that
  writes each, its configuration, the clock's start and its steps. The
  environment the host inherits isn't in the key.
- `--self-check` drives each run a second time with the test module's
  recording off, and fails a run whose request bodies differ once the
  run-varying values are masked in both, wherever they appear, cache markers
  included, where a record writes a marker whole: every record rests on
  recording changing nothing the host sends. It compares the bodies alone,
  not the headers, path or query; the record's heads hold the path, the query
  and the `anthropic-beta` and `anthropic-version` headers. With recording off the driver
  sets `FIXTURE_RECORD=off`, and otherwise leaves it unset, dropping a
  runner's own, so a runner's setting can't turn the recording arm off. An arm
  with recording off that logged compile batches anyway can't be judged, nor
  can one whose drive failed, and the summary names which arm. Where they
  differ, the first differing pair of request bodies is kept in the run's
  evidence, under `self-check/`. CI runs it in six shares on a pull request
  that changes a file the test module loads; the host's own source, whose code
  runs within and around the compiles the module records, since a compile runs
  the agent's strategy, which can be the host's own, and the host's modules
  gather their context just before each request compile; `package.json` or a
  lockfile, which choose the stack the module runs beside; `run.mjs`,
  `driver.mjs` or `common.mjs`, which set up, drive and compare the two arms;
  or the workflow itself.
  A host change whose effect recording happened to hide would leave every
  record as it was, so only the self-check would show it.
- `--shard i/n` runs one of CI's shares, balanced by the seconds
  `stack.json` records.
- `--workdir DIR` keeps the run's installs and stores in `DIR`, which must be
  empty or new, since the release is installed there and every run's store
  starts there. The candidate is this checkout's own install unless
  `--overlay` is given, when it's installed there too.
- `--out DIR` chooses where each run's record, `report.txt` and view are
  written, and `run.json` and `summary.md`; it's `DIR/out` under the work
  directory when not given.
- `--update-seconds` merges this invocation's seconds, each run's and each
  checkpoint's, over the ones `stack.json` records, which `--shard` balances
  by. It writes the file through a temporary one, so an interrupted write
  leaves the old file whole. Two invocations writing at once each keep their
  own merge, and the later one's stands.

Records are made on Linux. The test module stamps each request compile from
the machine's monotonic clock, which it reads there (`module.mjs`), under Bun
through `clock_gettime` in `libc.so.6`. A run whose compiles carry no stamp is
refused as couldn't-run (`record.mjs`, `unrecordable`), so every run couldn't
run anywhere but Linux, and under Bun on a Linux whose C library isn't at
`libc.so.6`, such as a plain musl one.

A run that throws anywhere in its own work, from being set up to its
self-check, or whose checkpoint couldn't be made, couldn't run, with the
reason in the job's log and summary; the other runs go on, unless its
`report.txt` can't be written, which ends the invocation. Its committed
record is written with `--update-records` only after its last step, so a run
that couldn't run leaves the committed one as it was. A self-check whose
drive with recording off failed couldn't run, and one whose bodies differ
fails, but neither makes its run couldn't-run: the run's record is still
written with `--update-records`, and the invocation exits 2 or 1. A run whose last take of the test module's compiles at
a host's shutdown fails is a failed run, its record ending `end failed`, since
it lost what was compiled after the last settle.

A run that continues another starts from that run's checkpoint, written by the
release `stack.json` names, installed from that release's own lockfile, so the
records show the candidate against a fixed starting store. A run that
continues none (W1, W2 and others) starts empty under the candidate. Moving to
a newer release is a change of its own.

## Reading a record

A record opens with one header line: the run, and the checkpoint it starts
from (`empty` for one that starts empty). No record names a version. The
versions are in `records/versions.txt`, as the last invocation that updated
every record found them: the release that writes the checkpoints with its
stack, and the candidate's stack, one line each. The candidate's own version isn't in it, since a
release's `npm version` moves it, and neither is the Bun that ran, which a
run's `run.json` names. A run compares that file as it compares a record, so
a version change fails until the file is updated, and the job's summary names
each version that moved, once, above its table. A raise of a version that
changes nothing the host sends then moves one line in one file.

Then come two blocks. Each text the stack wrote is written once, in
`templates`, and each request head once, in `heads`; the lines below name
them.

- **`T:KEY = TEXT`.** A key is the text's role, its first three words with
  numbers as `#`, and the first 12 hex digits of the sha256 of the text as
  written, which for a text over 4,096 bytes is its `{ sha256, bytes, head,
  tail }` form:
  `T:user-clock-#-#-utc-9b6932fc9102 = Clock: #:# UTC`. A summary's key is
  instead `summary-lN-` and the first 12 hex digits of the sha256 of its whole
  text, the digits a long summary's `sha256` begins with. A key depends on its
  text alone, so a text leaving the set renames no other, and a one-word edit
  to a text renames it in every line that carries it, since each of those
  requests did change. Two different texts taking one key, a 48-bit
  collision, make the record refuse to be written, naming both. A
  summary's text is keyed by its level and that hash. A line that names a
  template gives its numbers after it: `[T:user-clock-#-#-utc-9b6932fc9102](12,10)`.
  A text's later lines are indented two spaces. A text over 4,096 bytes is
  written as `{ sha256, bytes, head, tail }`.
- **`H:KEY = model …, max_tokens …, stream …, thinking …, system …, tools …`.**
  One per distinct request head, keyed by a hash of it: the model, its limits,
  `tool_choice` and `thinking` as sent, each system block as a template with
  its cache marker (`^5m`, `^1h`, or `^null` for a `cache_control` sent as null) and a hash of any other field it carries
  (`{HASH}`), each tool by name and a hash of its whole
  definition, the `anthropic-beta` and `anthropic-version` headers, the
  path where it isn't `/v1/messages` and the query where there's one, and
  `rest`, a hash of anything else on the request body, where there's any.

Then each step of the run, in order, with what it made happen. Within a step,
the lines of requests are in the order the stand-in received them:

- **`compile ITEMS ^ N,M, head H:KEY, body HASH`**: a compile context-manager
  made and the request it was sent as.
  - **ITEMS** are the messages it sent. A stored message is named by the
    canary its text carries (`p.12.in`, `c.tool.call1`), and a run of messages
    stored next to each other as a range (`p.3.in-p.9.r1`). A message sent raw
    without one is its template. A summary is its level and the first and last
    messages it covers, `L1(p.3.in-p.5.r1)`, with `~` after it where only part
    of it went. A stored message without a canary is named, there and in the
    receipt line, by the nearest earlier message in its store that carries one
    and its place after it (`p.3.r1+2`), or by its place from the store's
    start (`start+3`), as check 11's flags name it. Names are as each store
    stood at the settle after that compile's step, where the log takes its
    store delta, so a later step's edit renames nothing earlier, and a
    message the delta reports removed anchors no name from then on.
  - **`!content` or `!shards`** after a name: context-manager's own provenance
    says that body went altered, or without all its shards. **`:no-thinking`**:
    the stored message holds thinking and the copy sent holds none. Either way
    it stands alone, outside any range.
  - **`compile -N + ITEMS`**: the agent's previous compile of the same kind
    (request or dry) less its first N items, then ITEMS added. So a change
    shows on the line of the request it changed. `= (as before)` is that
    previous compile again. Where no such N leaves the previous compile's
    items at the start of this one, as when an earlier item's form changed,
    the compile is written whole.
  - **`^ N,M`**: the places, in the list context-manager compiled, of the
    messages it marked for caching. The stand-in judges no cache marker; each
    is recorded as sent, a plain one as its TTL and any other shape whole. A
    marker on a message block or inside a tool result, wherever it was added,
    is held in the body hash; this list is context-manager's own marks, so a
    marker an adapter adds after the compile, or one nested in a tool result's
    blocks, moves the body hash without a place here. One on a system block
    shows in the head, after that block's template (`^5m`). One on a tool, on
    a message itself or on the body is held only in the tool's definition
    hash, the message's digest or the head's `rest`. A change to any of them
    moves the record, though only a system block's is written out.
  - **`head H:KEY`** appears when the agent's head differs from its previous
    request's. **`body HASH`** is a hash of each message as sent, digest and
    cache markers, so a change to any of them moves it, apart from the forms
    the record writes alike, listed after this list.
  - **`compile dry`** is a dry compile, which sends nothing.
    **`compile refused CLASS [T:…]`** is one that threw.
  - **`compile [AGENT]`** is another agent's than the fixture's own, such as a
    subagent or a reader, whichever compiled first.
- **`round + CANARIES, body HASH`**: a continuation round, a request sent with
  no compile of its own, with the canaries it carries beyond the agent's
  previous request. A request no compile pairs with is a round too, under
  `[sub]` where no agent of the stand-in's subagent side compiled at all.
- **`call CARRIED [T:…] -> SHAPE, head H:KEY, body HASH`**: a request to the
  summariser. CARRIED are the canaries of the messages it carried, each
  summary it carried by its name. The templates are its own words, such as its
  instruction. SHAPE is the stand-in's answer.
- **`unclassified CARRIED, head H:KEY, body HASH`**: a request the stand-in
  could tell neither as an agent's nor as the summariser's, such as one whose
  compression instruction it doesn't recognise, or one to any route but a
  POST to a path ending in `/v1/messages`, `count_tokens` included, which no
  run sends. Check 1 fails the run, naming the stand-in's reason, and the line
  lets the view show the request. The line carries no method, and a body that
  doesn't parse, or parses to a falsy value such as `null`, gets no head, so no
  path or query either; for a route the stand-in doesn't serve, the reason
  names the method and the path.
- **`action COMMAND`**: a host command the workload sent.
- **`wrote NAME [T:…]`** and **`removed NAMES`**: a summary the store added or
  changed, with its text, and those it removed. The driver takes the test
  module's compiles as each boot becomes ready, before the steps that follow
  it, and a manager's first take in a process lists its store whole. What it
  lists at the first boot is the store as the run began, so a checkpoint's
  summaries aren't written. What it lists after a restart is compared with
  what the record knew, so a summary the reloaded store lacks is `removed` at
  the restart's step, and a message it lacks names nothing from then on. An
  agent first seen later in the run, such as a subagent, has every summary it
  holds written.
- **`checkpoint NAME`**: where the script took a checkpoint.

The record ends with `end ok` or `end failed`, then each agent's last receipt,
`receipt AGENT #SEQ changes LEAF/KIND/LEVEL/LAST …` (`LEAF/removed` for a leaf
it removed), `totals`, and `judged`, each check's count of what it judged,
so a drop in a count that stays above zero moves a line. An agent whose last
reported receipt head is none, or couldn't be read, has no receipt line.

Image refs carry a nonce agent-framework mints for each process, so the record
names each nonce by the order it first appears (`img_na_1`, `img_nb_1`), and
the digests a body hash takes name it by its first appearance in that request
(`img_N1_1`). A fork's call id ends in a random UUID where the fork's own call
isn't in context, so the digests name each such UUID the same way. So a
request naming two image ledgers, or a call and a result naming different
forks, still differs from one that names one. The naming goes by the text's
form, so a text written in that form by anything else is named the same way.
The stand-in's thinking signatures hash the request ahead of them and the
thinking itself, and carry a digest of the thinking alone: a signature's
first 22 characters bind it to the request ahead of it and its last 21 are
the thinking's own, so it keeps the length of one digest, and the price of a
block, which counts its signature's characters, doesn't move. On every
configuration, a request whose latest assistant message holds a thinking block
whose text no longer matches that digest is refused with the extended-thinking
page's 400: "If thinking blocks are modified, the API returns a 400
`invalid_request_error` whose message contains `thinking` or
`redacted_thinking` blocks in the latest assistant message cannot be
modified" (https://platform.claude.com/docs/en/build-with-claude/extended-thinking,
`modifiedThinking`). Where the model binds, the stand-in checks every
assistant message's thinking this way, refusing an
edited block with that error's wording at its own index. That wording names
the latest message, and applying it to any message is the stand-in's own
reading of the troubleshooting page, which says that where a signature
"didn't verify", "`prefix_mismatch_behavior` doesn't apply. Edited thinking
text returns a different error", without limiting that error to the latest
message (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting).
Where the model doesn't bind, only the latest message is checked. On a
configuration whose model binds, a block whose text verifies but whose
signature no longer matches the request ahead of it is dropped where the
request asks `drop_block`, as the host's binding requests do, and refused
otherwise (`unbound` and `bindingRefusal`). The digests mask the signatures. The
stand-in's summary of a request is seeded from the canaries it carried, and
names the last of them, in an order of digit runs by number and the rest by
code unit, which needs no collation data that could differ between machines.

The stand-in prices the prompt cache by its own model of the provider's, from
the prompt-caching page
(https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and the
thinking page's "Thinking and prompt caching"
(https://platform.claude.com/docs/en/build-with-claude/thinking). It reads a
request's prefix as tools, then system, then messages. It reads back the
longest prefix it holds unexpired that ends within the page's lookback of a
cache marker: "The system checks at most 20 positions for each breakpoint,
counting the breakpoint itself as the first", where "a run of consecutive
`tool_use` blocks counts as one position, and so does a run of consecutive
`tool_result` blocks" ("How automatic prefix checking works"). It writes each
later marker's prefix for its own
lifetimes of 5 minutes or an hour. It doesn't write a prefix shorter than the
model's minimum cacheable length ("Cache limitations": 4,096 tokens for Claude
Opus 4.6 and 512 for Claude Opus 5.5), measured in its own pricing. The
messages' prefixes key on the thinking configuration, its mode and
`budget_tokens`, which the prompt-caching page says is rendered into the
prompt, so changing it always invalidates the messages cache. Tools and
system don't key on it: that page says they're invalidated too "on models
that render the configuration ahead of them", and neither page names one.
The key is the configuration as sent, so a request that sends its model's
default explicitly reads as a change, where the thinking page says setting a
parameter to its default is the same as omitting it. The messages' prefixes
also key on whether the request sends any image, in a message or a tool
result, since the prompt-caching page says adding or removing images anywhere
in the prompt invalidates the messages cache.

The prompt-caching page's "What invalidates the cache" also keys the
messages cache on `tool_choice` and `output_config.effort`, and the system
and messages caches on `speed`. No run sends any of them, so the stand-in
refuses a request that carries `tool_choice`, `speed` or `output_config` as
unclassified, naming the field, and the run fails. It does the same for a
model it knows no minimum for. So a host change that starts sending one stops
the runs, naming it, rather than reading as a cache read the provider
wouldn't give.

The stand-in prices text at its own rates, prose at 2.2 characters a token and
denser text at fewer, about 1.3 times context-manager 0.24.0's own estimate of
2.9 and 2.3 (`message-store.ts`), so context-manager's calibration has a gap to
close. It binds a signed thinking block to the system prompt, the tools, the
model, the body's other fields but `stream` and `metadata`, and the messages
before it, cache markers aside (`bindingIdentity`). The workloads size what
they send by the host's own limits: a document is several times the host's
default message cap of 10,000 tokens (`framework-strategy.ts`), so it's stored
in shards, and a large reply stays within the host's default reply ceiling of
16,384 tokens (`recipe-fit.ts`) at the stand-in's prose rate. An agent turns
the tool-result guard on with `toolsets--open` on its settings, then
`agent_settings`. While the stand-in holds a subagent's reply, the driver waits
for compression to go idle by maintenance passes rather than a settle, since
the turn whose request is held keeps the host from draining.

The harness leans on this host's own behaviour in five more places. A
recipe that leaves the strategy unset gets autobiographical, adaptive and
kv-unified with the standard block (`framework-strategy.ts`), and on
claude-opus-5-5 the host passes agent-framework's `thinkingBinding` and the
drop control (anima-research/connectome-host#500). A binding configuration
boots with the host's binding probe off (`THINKING_BINDING_PROBE`), since the
host shapes requests alike for no probe outcome and for an account that
refuses or drops a changed block (`logging-adapter.ts` tells only `shows`
apart). `/budget` writes a header, then a line per agent, `  <name>: …`,
which is how the driver knows the report has ended. A maintenance pass
returns at once while a compression the host's auto-tick started is in
flight, and no event marks that work's end, so a settle waits for the test
module's tick counts too. And the web UI, which W6 and W9 open, is a WebSocket to
`/ws` on the URL the host logs (`[webui] listening on <url>`), whose welcome
names the session (`welcome.session.id`), which a session-changing message
such as `suppress` must carry.

A store read the test module couldn't make is a line of its own,
`unreadable messages: REASON`, `unreadable summaries: REASON` or
`unreadable receipt: REASON`. An agent that has left agent-framework's
registry, which deregisters an ephemeral agent at its run's end without
closing its manager, is read from the manager kept from its compiles, until
its compression ticks settle and while a take of it reads unreadable, so what
a take couldn't read is still reported once it can be.

A request's line, with the head in force for it, changes whenever what that
request sends changes, apart from what the record leaves out or writes alike
and the run-varying values it masks by their pattern in the messages, the
system prompt and the digests of the tools and the body's other fields, the
run's own text included (an image-ref nonce in any string there but a cache
marker, which it writes whole; a fork call's UUID in the system prompt and the
digests, though a message's or summary's text the record writes from a compile
keeps it as it is; and the signature of any object typed `thinking`), a change to one of which alone moves no line.
The head's other fields, the model, `max_tokens`, `tool_choice`, `thinking`,
the tools' names, the headers, the path and the query, it writes unmasked,
and no run puts such a value in them. It leaves
out every header but `anthropic-beta` and `anthropic-version`, and keeps the
betas as a set, so their order and repeats move nothing. It writes alike an
omitted or null `system`, an empty list, and any other value that is neither a
string nor a list, while a string, the empty one included, is one text block;
an omitted, null or empty `tools`; a system prompt sent as a string and
as one text block, and a system block's null or missing text and an empty
one; an omitted `thinking` and a null one; any `stream` but `true` and none;
an ephemeral cache marker with no TTL and one of `5m`; and a message's string
content and one text block, and its null or missing content, or any that is
neither a string nor a list, and an empty list. It writes alike an omitted and
a null `model`, and an omitted and a null `max_tokens`, each of which the
stand-in refuses. A `tool_choice`, even a null one, is refused as
unclassified, as above, and the head writes a null one as none. A head is named only on the
first line of its agent's under it, so a later request under a changed head
keeps its line, and the view still names it.

A line can also change when nothing its request sends does. Its delta is from
its agent's previous compile, so a change to that compile moves it too. A
summary is named by the messages context-manager's provenance says it covers,
so a change to that provenance renames it. And `^` lists context-manager's own
cache marks, so a mark moved between the compile and the request's assembly
moves the line, with the body hash unchanged. No change to one text renames
another, since each key comes from its own text. The record's other lines
record the store and the run: summaries written and removed, reads that
failed, actions, checkpoints and the end.

## The view of what changed

The record diff says that a request changed. The view, which `run.mjs` writes
beside the records and never commits, says what the resident received. A
request it shows is one whose line, read without its head note and with the
head in force for it, differs from the committed record's. A removed request
line (one carrying a body hash) identical to an added one elsewhere is a
request sent at another place. Within each hunk of the diff, an added
request line pairs with the removed one of its kind and agent it shares most
items with, among those written the same way, as a change or whole, while
any is left; a removed one left unpaired is a request the run no longer
sends. The pairing is the view's best reading; the record diff beside it is
what holds.

- **`summary.md`** has one row per run: its outcome (`pass`, its flags' count,
  `invalid`, or why it couldn't run, then the self-check's outcome where one
  ran), whether its record matched, and for one that differs how many requests
  changed, then its counts. Those are, across every agent, the request compile
  calls made and refused (a refusal whose retry compiled counts as one of
  each), the compression and merge calls, and the quarantines held at the
  run's end; then the stored messages raw, summarised and left out at the last
  compile of the agent its checks judge (named in the row, H2's knowledge
  subagent for H2), the tokens sent (cached and uncached input), and the
  compile lines whose check 11 entries hold a breach or a part it couldn't
  judge; a compile it couldn't record isn't among them. `?` is a count the run
  couldn't give. Where anything isn't clean, the table is followed by where
  each run's report, record and view are in the job's evidence and what to do
  next, then every flag of each flagged run. A missing product and a
  calibration edge, which a report counts apart from its flags, are in the
  run's `report.txt`.
- **`<run>/view.md`**, for each run whose record differs or isn't committed,
  has a section for each request whose record lines changed. Each section has
  its record line in its heading, cut at 200 characters (a changed line's
  moved items follow it whole, and a new or moved request's whole line is in
  the record diff), then, for an agent's request, the ledger of where each
  message of its turn's compile's view went (raw, raw with its body
  incomplete, under which summary, or left out: its one unit in
  context-manager's layout, so a message sent raw shows raw even where a
  summary sent also covers it, which check 11 flags), headed "As
  context-manager compiled it", since agent-framework can still drop a row after the compile,
  then the request's system prompt, tools and messages as the resident
  received them (its model, `max_tokens`, `stream`, `tool_choice`, thinking,
  headers, path and query, and `rest`, a digest of every other body field, are
  in the record's head line, named by key on the first request's line under
  it):
  - the stack's words, verbatim: the system prompt, each tool's definition,
    templates, notices and framing. The run's content is marked in messages
    alone. Run content a host put into the system prompt or a tool's
    description would show there verbatim, as stack words, while the record's
    head line still moves;
  - the run's own content, as its mark, its length and a short head, with
    `chars a–b of n` where only part of it went, thinking included. A stretch
    shorter than 32 characters is never taken as the run's, and one shorter
    than 47 may not be, since the index keeps a 32-character key every 16
    characters, so it shows verbatim whoever wrote it: a short reply, an image
    result's bare canary, or a heading context-manager split into a block of
    its own. A run span ends where the request's text stops matching the text
    the run generated, so if a stack text continues a cut run text with the
    very characters the run text goes on with, those characters show inside
    the span. A change there still shows, as a different span and the changed
    words;
  - a message's fields besides its role and content, shown beside its role,
    and a block's fields besides those its line shows, shown beside its type,
    each masked as the message's digest masks it. A transcript of a request
    holding a result opens with the form nearly every result in the runs
    takes, content as a string with `is_error: false`. A result in that form
    is unmarked, and one departing from
    it says how, as `(content as blocks)` or `(no is_error)`, since the digest
    tells those forms apart and a mark on every line would show no change;
  - a tool's definition already shown in that view is named again rather
    than repeated, and so is any other stack text of 200 characters or more;
    a shorter one always shows.
- **On GitHub,** the job's summary holds `summary.md`'s text and then as many
  views as fit within its 1 MiB, GitHub's limit for one step's summary
  ("Step isolation and limits" in its workflow commands reference), naming
  each one that didn't fit and where it is in the evidence the job keeps, or,
  where even those names wouldn't fit, saying how many didn't. Where
  `summary.md` itself is longer, the summary holds as much of it as fits and
  says how many flags it left out; every flag is in `summary.md` and in its
  run's `report.txt`. The evidence is each job's uploaded artifact,
  `whole-host-N` for share N, or `whole-host-self-check-N` for the
  self-check's, and `--out` locally.

## What each run's checks judge

Each run's `report.txt` lists its flags, the expected failures that cover some
of them, and the checks' counts. A flag, a note or a reason the record or the
summary shows cut short, such as a thrown error, a command's output or a long
list of names, has its whole text on the line under it, `  whole: …`; a run
that couldn't run has its reason there, whole the same way. Two reasons are
exceptions: a failed read's, of a store, a strategy or pins, shows its first
200 characters, with no whole in `report.txt`, though the run's `log.jsonl`
keeps the whole of the test module's own reads of a store's messages, its
summary listing, its receipt and its quarantine, and a self-check's that couldn't run is in the summary and the job's
log but not `report.txt`, with no whole where it was cut. A host's whole
output is each boot's `host-N.log`, in the run's directory, or in
`checkpoints/RUN/` for the drive that writes RUN's checkpoint; a failure that
shows the host's last lines names that file.

- **Check 1: every turn answers.** It flags a request the stand-in refused or
  couldn't classify, an inference that failed or was exhausted, an operator
  alert the host raised, a checkpoint that didn't settle, and a turn whose
  answer the host reported it couldn't route to its channel. A step a workload
  marks `mayFail` may fail by design: its failure and its context refusal are
  its workload's property to judge. Workloads mark only the turns a budget cut
  can make fail: W8's and H4's reader's from the first cut through the two
  turns after the restore, which W8's property allows, and W11's from its cut
  to its restore. A step marked `retries` meets a scripted error that
  agent-framework retries, so check 1 owns only that `inference:failed`, and
  the turn must still answer. Check 1 also flags a step that leaves a scripted
  reply unused, its agent's or its subagent's, since a run that doesn't use
  its script hasn't exercised what the script sets up, such as W9's fork. A
  step marked `mayFail` whose failure check 1 owns is exempt: its host
  refused before asking for the rest.
- **Check 2: declared products.** A continuation segment that declares a
  product exists to produce it, such as a merge, a request carrying both
  results with one an image, or a thinking-led call. Check 2 fails a segment
  that didn't. A configuration can declare no product for a segment, as one
  that doesn't summarise does for its merges, and check 2 then judges nothing
  there. A product that needs the final store, where the run has none, is
  counted beside the judged.
- **Check 3: budgets.** It holds each request the run's agent sent, as the
  stand-in received it, to the bound that governs it. The stand-in counts
  tokens by its own model, several percent from context-manager's estimate
  either way, so it holds requests to the provider's window; context-manager's
  own count against its budget is check 11's.
  - **A compiled request**, a turn's first or a stream restart's, is held to the
    model's window by the stand-in's count of its whole input.
  - **A continuation round** is held to agent-framework's stream bound by its
    stream's fresh input before it, the `input_tokens` summed from the turn's
    compiled request onward, as membrane sums its usage. A subagent's bound is
    the one its launch notice states.
  - **Where the host reports, for a binding model, that the agent's window and
    not its stream bound breaks its stream,** rounds aren't held to the stream
    bound, and the report's notes say so.
  - **A request answered with a provider error isn't judged,** and its retry is.
  - **It can't judge** a request with no usage, a host report of a bound other
    than the one it holds, or an agent with requests and no compile line. Each
    is a flag of its own.
- **Check 4: coverage.** Every stored input and reply goes out in each request,
  raw or inside a summary sent, once, and in store order within its window.
  It applies where the run's store was read and holds a summary: a run that
  completed under a configuration that compresses (`judge.mjs`), so not H3's
  passthrough runs. A store with no summaries is check 5's `no-summaries`
  flag, and checks 4 and 5 judge nothing of it, as in
  C3h/W7/fable-no-tools, whose expected failure covers that flag. A request
  whose own input the final store doesn't hold isn't judged, and the report's
  judged line counts those beside what it judged. A subagent's inputs carry
  canaries of their own rather than a step's `.in`, so a subagent request's
  own input is the newest stored message it carries, and a message stored
  after it isn't asked for.
- **Check 5: bookkeeping.** Every summary declares only sources its
  compression request showed: the inputs and replies it covers, or the
  summaries it merges. For a subagent, whose inputs and replies carry canaries
  of their own, every source it covers. For the primary agent, a summary of
  tool results alone holds nothing to its request, and isn't counted as
  judged; nor is a merge of such a summary when neither its number nor its
  sources' numbers were sent, since a merge can carry it as its sources raw.
  Where the store holds a summary a summariser request wrote and check 5
  judged none, that's a couldn't-judge flag. A summariser answer whose summary
  the final store doesn't hold, and a source nothing of which carries a canary
  to tell by, are counted beside the judged. A source the store read doesn't
  hold is a flag. A summary context-manager wrote with no summariser request,
  such as a quiet stretch's, carries no stand-in mark, so check 5 can't judge
  it, and the report's notes name it.
- **Check 6: windows raw.** Each request carries raw the two turns before its
  own, less what an operator suppressed before it, and each segment's last
  request the head and the raw tail the host reported at its checkpoint. A
  message of those two turns that the final store doesn't hold isn't asked
  for, and the judged line counts those. Each checkpoint tail judged counts
  as judged, and one whose last input the final store doesn't hold is counted
  beside. Judging none is a flag only for the primary agent's requests. For
  H2 it runs on the knowledge subagent's requests, which its checks judge, and
  judges none of them, since the subagent's store holds no turn the window
  asks for.
- **Check 10: calibration edge.** A calibration multiplier at the clamp's edge
  (0.6 or 1.8) makes the run invalid, since its folds are clamped. It reads
  the multipliers in the host's health panel, at each checkpoint and at the
  run's end, and applies to an adaptive configuration whose panel reports a
  context composition. A read that failed, the panel answering `ok: false`
  or naming a `contextComposition` read failure, is a couldn't-judge flag,
  and so is a completed adaptive run that logged no end-of-run read, read or
  skipped. A panel that reports none holds nothing it could
  judge: the host's panel gives an agent's composition from its last live
  compile, and context-manager keeps none after a branch switch until the
  next one. H4/W1's `/undo` switches the resident's branch while it's tuned
  out, so its end panel reports none.
- **Check 11: compile invariants.** What the test module found wrong with each
  compile context-manager made, judged on what it sent against the store it
  compiled from, as it stands when the compile returns: the agent's own slot,
  and for an agent whose view merges another's, such as the Subconscious
  reader, the members of its view that slot holds. Each flag is named
  `agent:kind:invariant`.
  - **`coverage`:** where the strategy compresses, every stored shard goes out,
    raw or under a summary sent, and no stored message goes out under two.
    A summary sent in more than one message counts once: context-manager's
    autobiographical strategy sends a summary as a recall pair, a question and
    its answer. A raw copy of a body holds a shard when it carries every shard,
    which context-manager says by not marking it `!shards`, or when it carries
    that shard's text. Text is matched among the shards context-manager's
    layout sends raw, where it names any of that body's, and a shard with no
    text is held by any raw copy of its body.
    Each message covers nothing earlier than the one before it, in store order,
    except that after a head-window reset the head, which starts at the newest
    topic transition, goes first and the history from before it follows. A
    message is placed by the earliest stored message it carries: a raw copy by
    the earliest shard whose text it holds, among those context-manager's
    layout sends raw, each occurrence of a shard's text taken once, in order,
    so a repeated copy takes its own; or, where it holds none, by the first of
    those shards if it is the body's one copy and carries every shard.
  - **`beside-sources`:** no stored message goes out raw beside a summary of it.
  - **`budget`:** a compile that enforces its budget sends no more than its
    input budget plus the strategy's grace, or refuses. A compile given no
    budget is held to context-manager's own default. A compile is judged on
    its own render stats, a dry one's included, never the manager's last live
    compile's. A compile whose strategy gives no render stats, such as
    passthrough, isn't judged for its budget: the report counts those
    compiles beside check 11's judged ones, by strategy, and so does the
    record's `totals` line.
  - **`shape`:** a call and its result that the store holds together aren't
    sent apart. A passthrough's promise is narrower: no request opens with a
    result whose call lies before its start.
  - **`thinking`:** a stored body's thinking goes out with its calls, or not at
    all.
  - **`pins`:** a summary sent over pinned messages is at a level the pin
    allows.
  - **Couldn't-judge flags,** which say what wasn't judged rather than that
    context-manager broke something, each counted beside check 11's judged
    compiles in the report:
    - **`unplaced`:** what store order couldn't place: a raw copy that holds
      none of its shards' text, where the body goes out in several messages or
      its one copy doesn't carry every shard; a copy of a body no
      slot read holds; or a summary none of whose messages a slot read holds.
      The order is judged without it.
    - **`unreadable`:** a read an invariant needs failed, or a compile whose
      strategy gives render stats gave none, so that invariant wasn't judged.
  - **`unrecordable`:** the module couldn't record the compile at all.
- **Check 12: reloads.** At a restart with a reload check, the dry compile
  after the boot matches the one before the shutdown: the same outcome, the
  same messages from the same stored sources with the same content, the same
  system injections. Two dry compiles that refused alike show no compile on
  either side, so that reload is couldn't-judge.
- **Check 13: pairing.** Every request compile reached a request: the first of
  its agent's requests to arrive at the stand-in after it, before the agent
  compiled again. The module stamps each request compile as it hands it back,
  and the stand-in each request as it arrives, both from the machine's
  monotonic clock on Linux, so the order is what happened. Any other request
  is a round. This rests on one agent's requests going one at a time, and on
  where agent-framework 0.32.0 makes a request compile, one made through the
  agent's `compileWithInjections` or `compileContext`: only at a stream's
  start, a restart included (at the context budget, or the tool-result guard's
  retry), with a compile refused and repeated within one start counted once.
  A compile is the request's only while agent-framework's call that assembles
  the request is open; one that work the call started makes after the call
  settles isn't the request's.
  Nothing in agent-framework's or connectome-host's own code calls
  `compileContext` or the direct inference API. A request compile that didn't
  go out while the agent's stream still had a round to send would pair with
  that round, as a restart's compile does. It judges
  each agent that compiles, its subagents and readers included, with a count of
  its own. It can't judge an agent where a compile or request carries no
  stamp, as on another platform, or where a pair's request doesn't end on its
  compile's last canary, which a clock the two processes don't share would
  show. The stand-in tells only the configuration's own agent's requests from
  the rest, so where two other agents compile, each gets a couldn't-judge flag
  instead.
- **Check 14: the workload's own property,** which `workloads.mjs` states for
  each workload. A property either counts what it judged or names the check
  that judges it, and is then held to that check's count. A completed run
  whose property does neither, or names a check that judged nothing, is a
  couldn't-judge flag. The continuation names check 2, W7 without refused
  merges check 1, which flags every alert not owned, and W9 check 12. W5
  takes each body from every messages read, so a body removed before the
  run's last read is still judged in the requests that sent it. W4 judges
  each of its own calls: its script gives each reply one call with its
  thinking ahead of it, and membrane merges two replies left adjacent, as
  when the result between them and the second's thinking are both dropped,
  into one message, so each call needs a thinking block between the call
  before it and itself. W11 judges each pin it adds, the first included, by
  the panel's list after it: exactly one new pin, and none of the earlier
  ones gone.
- **Check 15: binding control.** On a model that binds thinking and takes the
  drop control, every agent request carries
  `thinking.block_binding.prefix_mismatch_behavior: drop_block`, the host's
  own rule, and asks for the `thinking-binding-controls-2026-08-01` beta that
  control needs, which membrane adds whenever it sends `block_binding`.
  Without them an enforcing account refuses a request carrying a changed
  block.

Each check reports how many items it judged, on the report's `judged` line.
A count shown as `?` is one the check couldn't establish, and its own flag
says why. Where a check applies to a run and judged nothing, that's a
couldn't-judge flag, never a pass.

## Expected failures

`test/whole-host/expected-failures.json` lists the flags of known findings
that the committed runs meet. Each entry has its `configuration` (a run),
`check`, `step` and `what`, the `finding` it belongs to and its `reason`, and a
`match`: the flag's detail as its report shows it, cut where the report cuts
it (its message, for a flag with no detail), as a literal, with each regular-expression metacharacter escaped by a
backslash and no other escape, anchored at both ends. The harness refuses an
entry whose match is anything else. So it covers exactly the flags of its
`what` showing that detail at its check and step: one, or several identical
ones where a step raises the same flag once per request. A flag that names no
`what`, such as check 1's refusals and check 12's, can't be covered, since an
entry must name one. Two more things are flags:

- an entry no flag meets, which means its finding no longer shows. The change
  that fixed it removes the entry;
- a flag two entries cover.

A check 10 clamp-edge flag is no entry's to cover: it makes the run invalid
whatever the entries say, and an entry written for one is reported unmet.

A flag no entry covers, beside an entry no flag meets at the same check and
step, usually means a known finding moved, such as a count or a message index
that changed. Read the two details. If it's the same finding, rewrite the
entry's `match` from the new flag. A person rewrites entries:
`--update-records` never does, since blessing new flags automatically would
hide the losses the entries are there to catch.

## When the format changes

A change to what a record writes changes every record, and updates this file
in the same pull request.
