# Whole-host records

`test/whole-host/` runs this host as residents run it, against a stand-in for
Anthropic's API, through a set of workload runs, and keeps one record per run
in `test/whole-host/records/`. A record says what every request the run sent
carried. A change that moves what residents' requests carry changes the
records, and their diff in the pull request is what to read.

## Running it

`npm run test:whole-host` runs every run, judges it, and compares each run's
record with the committed one. It exits 0 when every run passed and every
record matched, 1 when a run flagged something or a record differs, and 2
when a run couldn't run.

- `--runs A,B` runs only those (`CONFIGURATION/WORKLOAD[/VARIANT]`, as
  `workloads.mjs` `RUNS` lists them).
- `--update-records` writes each run's record over the committed one. Use it
  once the change a diff shows is the change you mean.
- `--overlay PACK.tgz` lays a packed agent-framework, context-manager,
  membrane or chronicle over this checkout's install, to see what a change to
  one of them does here. A host change is a change to this checkout itself.
- `--checkpoints DIR` keeps the runs' starting checkpoints in `DIR` between
  invocations, keyed by everything that writes them.
- `--self-check` drives each run a second time with the test module's
  recording off, and fails a run whose requests differ: every record rests on
  recording changing nothing the host sends. Where they differ, the first
  differing pair of request bodies is kept in the run's evidence, under
  `self-check/`. CI runs it in four shares on a pull request that changes a
  file the test module loads, a lockfile, which chooses the stack the module
  runs beside, or `run.mjs`, which drives and compares the two arms. A change
  to the host's own source doesn't schedule it: the records themselves
  measure what a host change does to requests.
- `--shard i/n` runs one of CI's shares, balanced by the seconds
  `stack.json` records.

A run that continues another starts from that run's checkpoint, written by the
release `stack.json` names, installed from that release's own lockfile, so the
records show the candidate against a fixed starting store. A run that
continues none (W1, W2 and others) starts empty under the candidate. Moving to
a newer release is a change of its own.

## Reading a record

A record opens with one header line: the run, and the checkpoint it starts
from (`empty` for one that starts empty). No record names a version. The
versions every record was made with are in `records/versions.txt`: the
release that writes the checkpoints, and the candidate's stack, one line
each. A run compares that file as it compares a record, so a version change
fails until the file is updated, and the job's summary names each version
that moved, once, above its table. A raise of a version that changes nothing
the host sends then moves one line in one file.

Then come two blocks. Each text the stack wrote is written once, in
`templates`, and each request head once, in `heads`; the lines below name
them.

- **`T:KEY = TEXT`.** A key is the text's role, its first three words with
  numbers as `#`, and the first 12 hex digits of the text's sha256:
  `T:user-clock-#-#-utc-9b6932fc9102 = Clock: #:# UTC`. A key depends on its
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
  its cache marker (`^5m`, `^1h`) and a hash of any other field it carries
  (`{HASH}`), each tool by name and a hash of its whole
  definition, the `anthropic-beta` and `anthropic-version` headers, and
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
    previous compile again.
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
    cache markers, so any change to what was sent moves it.
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
  compression instruction it doesn't recognise. Check 1 fails the run, and the
  line lets the view show the request.
- **`action COMMAND`**: a host command the workload sent.
- **`wrote NAME [T:…]`** and **`removed NAMES`**: a summary the store added or
  changed, with its text, and those it removed.
- **`checkpoint NAME`**: where the script took a checkpoint.

The record ends with `end ok` or `end failed`, then each agent's last receipt,
`receipt AGENT #SEQ changes LEAF/KIND/LEVEL/LAST …` (`LEAF/removed` for a leaf
it removed), and `totals`. An agent whose last reported receipt head is none,
or couldn't be read, has no receipt line.

Image refs carry a nonce agent-framework mints for each process, so the record
names each nonce by the order it first appears (`img_na_1`, `img_nb_1`), and
the digests a body hash takes name it by its first appearance in that request
(`img_N1_1`). A fork's call id ends in a random UUID where the fork's own call
isn't in context, so the digests name each such UUID the same way. So a
request naming two image ledgers, or a call and a result naming different
forks, still differs from one that names one. The stand-in's thinking
signatures hash the request ahead of them, so the digests mask them.

A store read the test module couldn't make is a line of its own,
`unreadable messages: REASON`, `unreadable summaries: REASON` or
`unreadable receipt: REASON`.

A request's line, with the head in force for it, changes if and only if what
that request sends changes. A head is named only on the first line of its
agent's under it, so a later request under a changed head keeps its line, and
the view still names it. A request's change can also move its agent's next
compile line, whose delta is from it. No change to one text renames another,
since each key comes from its own text. The record's other lines record the
store and the run: summaries written and removed, reads that failed, actions,
checkpoints and the end.

## The view of what changed

The record diff says that a request changed. The view, which `run.mjs` writes
beside the records and never commits, says what the resident received. A
request it shows is one whose line, read without its head note and with the
head in force for it, differs from the committed record's.

- **`summary.md`** has one row per run: whether its record matched, and for
  one that differs how many requests changed, then its counts. Those are the
  request compiles made and refused, the compression and merge calls and the
  quarantines across every agent, the stored messages raw, summarised and left
  out at the last compile of the agent its checks judge (named in the row,
  H2's knowledge subagent for H2), the tokens sent (cached and uncached
  input), and the compile lines whose check 11 entries hold a breach or a
  part it couldn't judge; a compile it couldn't record isn't among them. `?`
  is a count the run couldn't give.
- **`<run>/view.md`**, for each run whose record differs or isn't committed,
  has a section for each request whose record lines changed. Each section has
  its record line, then, for an agent's request, the ledger of where each
  message of its turn's compile's view went (raw, raw with its body
  incomplete, under which summary, or left out: its one unit in
  context-manager's layout, so a message sent raw shows raw even where a
  summary sent also covers it, which check 11 flags), headed "As
  context-manager compiled it", since agent-framework can still drop a row after the compile,
  then the request as the resident received it:
  - the stack's words, verbatim: the system prompt, each tool's definition,
    templates, notices and framing;
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
  - a message's fields besides its role and content, shown beside its role;
  - a tool's definition already shown in that view is named again rather
    than repeated, and so is any other stack text of 200 characters or more;
    a shorter one always shows.
- **On GitHub,** the job's summary holds the table and then as many views as
  fit within its 1 MiB, naming each one that didn't fit and where it is in
  the evidence the failed job keeps.

## What each run's checks judge

Each run's `report.txt` lists its flags, the expected failures that cover some
of them, and the checks' counts.

- **Check 1: every turn answers.** It flags a request the stand-in refused or
  couldn't classify, an inference that failed or was exhausted, an operator
  alert the host raised, and a checkpoint that didn't settle. A step a workload
  marks `mayFail` may fail by design: its failure and its context refusal are
  its workload's property to judge.
- **Check 2: declared products.** The continuation's segments each exist to
  produce something, such as a merge, a request carrying both results with one
  an image, or a thinking-led call. Check 2 fails a segment that didn't.
- **Check 3: budgets.** It holds each request the run's agent sent, as the
  stand-in received it, to the bound that governs it.
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
- **Check 5: bookkeeping.** Every summary declares only sources its
  compression request showed: the inputs and replies it covers, or the
  summaries it merges. For a subagent, whose inputs and replies carry canaries
  of their own, every source it covers. For the primary agent, a summary of
  tool results alone holds nothing to its request, and isn't counted as
  judged; nor is a merge of such a summary when neither its number nor its
  sources' numbers were sent, since a merge can carry it as its sources raw.
  Where the store holds a summary a summariser request wrote and check 5
  judged none, that's a couldn't-judge flag. A source the store read doesn't
  hold is a flag. A summary context-manager wrote with no summariser request,
  such as a quiet stretch's, carries no stand-in mark, so check 5 can't judge
  it, and the report's notes name it.
- **Check 6: windows raw.** Each request carries raw the two turns before its
  own, less what an operator suppressed before it, and each segment's last
  request the head and the raw tail the host reported at its checkpoint.
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
  system injections.
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
  each workload.
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
`match`: the flag's whole detail (its message, for a flag with no detail),
as a literal, with each regular-expression metacharacter escaped by a
backslash and no other escape, anchored at both ends. The harness refuses an
entry whose match is anything else. So it covers exactly the flags with that
detail at its check and step: one, or several identical ones where a step
raises the same flag once per request. Two more things are flags:

- an entry no flag meets, which means its finding no longer shows. The change
  that fixed it removes the entry;
- a flag two entries cover.

A flag no entry covers, beside an entry no flag meets at the same check and
step, usually means a known finding moved, such as a count or a message index
that changed. Read the two details. If it's the same finding, rewrite the
entry's `match` from the new flag. A person rewrites entries:
`--update-records` never does, since blessing new flags automatically would
hide the losses the entries are there to catch.

## When the format changes

A change to what a record writes changes every record, and updates this file
in the same pull request.
