# Changelog

Entries land with the change that causes them, as fragment files in
[`changelog.d/`](changelog.d/) that are folded into a version section at
release time — see [CONTRIBUTING.md](CONTRIBUTING.md#changelog).

## Unreleased

## 0.11.0 — 2026-10-20

### Breaking

- **Operators:** connectome-host now requires `@animalabs/agent-framework`
  ^0.23.1 (was ^0.22.4), whose 0.23.0 opens a new line with breaking
  changes. The ones a host's operators meet, in brief; agent-framework's
  0.23.0 notes give each in full:
  - **MCPL servers' revision:** the MCPL engine now requires
    `protocolVersion` `2024-11-05` back from `initialize`. A server that
    answers another revision, or none, is refused for good, with no
    reconnect, and raises an `mcpl-down` ops alert. A hand-written server
    that omits the field must add it.
  - **Tool prefixes:** two MCPL servers whose `toolPrefix`es meet, as `foo`
    and `foo--bar` do, are refused at startup, at a runtime connect and at a
    restart. Change one of the two prefixes, such as `foo-bar` for
    `foo--bar`.
  - **A server entry with both `command` and `url`** and no `transport` is
    refused before anything is spawned or dialed, where it was launched as
    stdio and the url ignored. Drop the field you don't use, or set
    `transport`.
  - **`codeExecution`:** the python interpreter that runs model-authored
    scripts no longer inherits the host's environment, only an allowlist
    (`PATH`, `HOME`, the locale, temp directories, CA bundles and proxy
    variables) and `codeExecution.env`, and it starts in its own runtime
    directory, which teardown removes. List a variable a script needs in
    `codeExecution.env`, which a recipe can `${VAR}`-substitute from
    `.env`, and give a file a script keeps an absolute path.
    `codeExecution.inheritEnv: true` restores the whole environment,
    provider keys included.
  - **Workspace mounts with symlinks inside them:** on a mount that doesn't
    set `followSymlinks: true`, a file reached through a symlinked directory
    inside the mount is no longer read, written or synced through the link,
    and a file the host reads from disk behind one, such as an
    instructions file, is refused with a refusal that names the link.
  - **Two agents with one name** in a config are refused before the store
    opens.
  - **Tool definitions change**, `code_execution`'s among them, so a
    resident misses the prompt cache once, from its tool block on, at its
    first request after the upgrade.
  - `refusalHandling.announceHumanTurns` is removed in the framework, which
    never read it. A recipe that still sets it starts as before, with the
    setting ignored.
  - Going back to connectome-host 0.10.x installs agent-framework 0.22.x
    from its lockfile. agent-framework's notes don't say whether 0.22.x
    opens a store 0.23 wrote; back the store up before upgrading.

- **Recipe authors whose recipes set `agent.allowedTools` to a list:** the list now decides which tools the resident is offered, and the subagents it spawns or forks get the same list or a narrower one, plus `subagent--return`. Earlier versions ignored the field with a startup warning, so the resident and its subagents had every tool.
  - Before upgrading, check that the list names every tool the resident and its subagents use, framework tools such as `think` and `prose_help` included, with `utils` and each utility's own name (`module--name`) for the utilities they run. Or remove the field to keep every tool.
  - A value other than `"all"` or an array of tool names now stops the recipe from loading.
  - With Agent Framework 0.22.1, naming `utils` still lets the resident run every registered utility, and a call to a tool the list leaves out still runs. The Framework release from https://github.com/anima-research/agent-framework/pull/220 checks each utility's own name and refuses calls to tools the list leaves out.
  - Unchanged: a recipe without `agent.allowedTools`, or with `"all"`, keeps every tool.

- **Operators with links inside a workspace mount:** a mount doesn't follow links unless the recipe sets its `followSymlinks`, so on such a mount a file that is itself a link, even one to another file in the same mount, is no longer read. The web UI's `/files/` route answers 403 for it. The instructions module injects nothing for such an instructions file, so agents run without their instructions, and an `instructions-unavailable` alert says so. The activity module no longer takes a typing notice's origin hint from such a file. Replace the link with the file it points to, open the file by its own path, or set `followSymlinks: true` on the mount. Unchanged: a file named by its own path is read as before, and so, on agent-framework releases before anima-research/agent-framework#468, is one reached through a linked directory, as long as it lies inside the mount.

- **Operators with links inside a workspace mount:** `identity--request` no longer uploads a link in a mount, even one to another file in the same mount, unless the mount sets `followSymlinks`. 0.10.2 sent the file the link pointed to. Upload the file by its own path, or set `followSymlinks` on the mount. Unchanged: a mount with `followSymlinks` still follows a link that stays inside it, and a file uploaded by its own path is sent as before.

- **Recipe authors and operators:** the host defaults for omitted memory fields changed.
  - An omitted `agent.strategy.foldingStrategy` (autobiographical or frontdesk, adaptive
    resolution on) is now `kv-unified`, with the host's standard `kvUnified` block, not
    `kv-stable`. A resident whose store was built under kv-stable switches solver on its
    first boot after the upgrade (a layout change: one full prompt-cache rewrite). To keep it
    on kv-stable, set `"foldingStrategy": "kv-stable"` before upgrading.
  - An omitted `agent.contextBudgetTokens` is now 300k (was the context manager's 100k).
    The default assumes a 1M-window model: a recipe on a 200k-window model must set its own
    budget, or every reply is rejected for exceeding the window.
  - An omitted `agent.strategy.recentWindowTokens` is now 40% of the budget (120k at the
    300k default), was 30k.
  - An omitted `agent.maxStreamTokens` is now 320k when the budget is omitted too. With an
    explicit budget it stays 150k.
  - Selecting `kv-unified` without a `kvUnified` block now gets the standard block instead of
    failing at load. The block's cache prices are matched to what the provider bills, as
    multiples of base input. Claude: writes 2 on the 1-hour cache, 1.25 on the 5-minute cache
    and on Bedrock; reads 0.1, except 0.05 on Claude Opus 5.5 and 0.025 on Claude Fable 5.1 /
    Mythos 5.1. Claude Sonnet 5.5's reads are billed at 0.05 but take 0.1 here. OpenAI:
    writes 1.25 on the API for the GPT-5.6 and GPT-6 families, else 1, and 1 on Codex; reads
    by model (0.1 on most, 0.05 on GPT-6.1 Sol). With prompt caching
    off (`agent.promptCaching: false`, or a Bedrock model without caching) both are 1. A
    written block must still be complete.
  - The built-in default recipe (no recipe argument and no saved recipe, or `--no-recipe`)
    now has an empty system prompt and takes all of these defaults.
  - Unchanged: recipes that set these fields explicitly, and complete `kvUnified` blocks,
    which pass through as written. The context manager still always receives a complete
    block.
- `agent.strategy.kvUnified.hysteresisCertificate` is now part of the recipe type, and a
  non-boolean value fails at recipe load. It was already passed through.
- The context curve panel, when it can't read the live budget, falls back to the recipe's
  budget or the 300k default, not 200k.

- **Recipe authors:** a workspace mount, or `modules.workspace` itself, that names a key the host doesn't read, or gives a key a value of the wrong kind (`null` included), now stops the recipe loading with an error that names it (#275), as `agent.retry` and `modules.history` already do. Before, such a key was dropped without a word, so a mount written with `readOnly: true` stayed read-write. `modules.workspace` set to anything but `true`, `false` or an object now stops it too, where it used to build the default mounts or, for `null`, crash, and so does a `modules` that isn't an object (`null` and a list included), which built the default mounts. A mount takes `name` and `path` (non-empty strings), `mode` (`"read-write"` or `"read-only"`), `watch` (`"always"`, `"on-agent-action"` or `"never"`), `watchDebounceMs` (whole milliseconds from 0 to 2147483647, the longest delay a timer keeps) and `watchRootPollMs` (whole milliseconds from 1 to 2147483647: a poll of 0 runs as often as one of 1), `ignore` (a list of strings), `followSymlinks` and `autoMaterialize` (`true` or `false`), `maxFileSize` (whole bytes, 1 or more: a cap of 0 refuses every file that isn't empty), `walkCap` (whole entries from 1 to 9007199254740991, as agent-framework takes it) and `wakeOnChange` (`true`, `false`, or a list of `created`, `modified` and `deleted`). The workspace takes `mounts` and `configMount` (`true` or `false`). To migrate, fix what the error names, so `readOnly: true` becomes `mode: "read-only"`, as its error says, or remove it where it was never meant to do anything. A recipe whose mounts use only those keys, with values as listed, loads as before, except that `walkCap`, `followSymlinks`, `watchDebounceMs` and `watchRootPollMs`, which the host used to drop, now take effect where it sets them.
  - **Operators:** a session resumed without a recipe argument checks its saved recipe (`.recipe.json` in the data directory) the same way, and a saved recipe that doesn't pass stops startup with an error naming that file. Fix what the error names (the file, or a variable missing from the environment), start with a recipe file to replace it, or start with `--no-recipe` to clear it, which removes a file or a link there, a link to nothing included. A directory at that path, or a link to one, was never a saved recipe. For one, the error says it's a directory, or a link to one, and gives the fix that works, to move or remove it, adding that the source of a bind mount there has to be a file that exists before the container starts. A recipe file stops with the same line, since it can't be written over a directory, even through a link, and so does `--no-recipe` for a directory itself, which it leaves in place. A saved recipe that can't be read, a link to nothing included, isn't JSON or isn't a JSON object, such as one torn by a crash while it was written, or one from a host older than 0.8.0 that doesn't validate, now stops startup the same way, where it used to start the default recipe in its place without a word.

- **Operators and developers:** install and run connectome-host on Node
  22.12 or later and Bun 1.4.3 or later. `package.json` now declares both
  (`engines.node: ">=22.12.0"`, `engines.bun: ">=1.4.3"`). npm warns at an
  install on an older Node; npm 11 and Bun 1.4.3 don't check the Bun floor
  at install.
  - **Node** runs the install, whose postinstall builds the Web UI with npm
    and Vite, and the release-hold checks. Node 20 reached its end of life
    on April 30, 2026, and Node 22 is the oldest line Node still supports.
    22.12.0 is the floor the stack's packages share, and every locked
    package that states an `engines.node` admits it.
  - **Bun** runs the host. None of Bun's releases went to an older minor
    after a newer one shipped, so the floor is its newest release when it
    was set, 1.4.3, and nothing older is tested in CI or supported.
  - **CI** runs the install, the Web UI build and the tests on Linux at Node
    22.12.0 with Bun 1.4.3, at Node 24 with the newest Bun, and at the newest
    Node with the newest Bun, and the install and build on macOS at the two
    ends. Its build-and-test check names now carry the Node and Bun each
    job asks for.

### Added

- The host warns at start when the Bun running it is below the floor its
  `package.json` declares (`engines.bun`), naming both versions, since below
  that floor it can fail in ways that don't name Bun. It warns and carries
  on, and the TUI shows the same line in its own view.

- An `instructions-unavailable` ops alert whenever a turn of the running session gets no instructions: no workspace, an unknown mount, a missing or unreadable file, a file that is itself a link or that lies outside its mount, or a read that hasn't finished in 1.5 s. It says why, and what to do where the reason alone doesn't. It reaches the TUI, the web UI's alert strip, `failures.log`, the ops webhook and, at the `status` tier, the notices module's status channels. `instructions-unavailable-clear` stands it down once the file loads again, after a session switch too. Each reason is raised once in a session until then, under the name of the agent the host runs. Before, an agent running without its instructions showed only as a log line. One read is in flight at a time in each session: a read that never finishes, such as one waiting on a FIFO at the path, leaves agents without their instructions until it finishes, the session is switched or the host restarts, and no other read starts in that session, where before each turn opened the file again, and each open waited on the FIFO too.

- A forked or spawned stream is told what it runs on before its first inference, and its caller's receipt describes the same launch. `subagent--fork` and `subagent--spawn` resolve one launch description at the call, then create the stream from it.
  - **What the description covers:** lineage and depth, model, provider, system-prompt source, strategy, head and recent windows, message cap, compression model, stream budget, output limit, prose routing (with what the mode does to the stream's plain text) and tool rules.
  - **The caller's values:** each setting is set beside the caller's value at the call. A setting the caller doesn't report is marked as not compared, never assumed equal. A fork's summary sorts every setting into differs, same, and not compared.
  - **Where it appears:** a fork's intention-framed tool result (on the structural and the fallback path) states the description verbatim, after the framing and before the return instruction and the restated intention. A spawn and a parentless fork get it as their own first message (a parentless fork's ends with the return instruction), followed by their task alone in a message of its own. Each message in a stream's context is capped alone at 10,000 tokens, and the cap keeps a message's beginning. So a spawn's orientation and task each have the whole cap, and a structural fork's result leads its message, ahead of the other results its parent's turn returned. The native formatter merges the orientation and task messages into one user turn; the anthropic-xml and openai-responses formatters send them as two consecutive user turns.
  - **Three lists are partial:** the caller's restriction where the tool rules set the stream's beside it, the caller's rules the stream isn't given at the call, and the tools a fork has beyond its parent's are named up to ten and the rest counted. The stream's request defines every tool it can call. Everything else is named in full: what the stream's rules give it, a spawn's or parentless fork's whole surface, the names a spawn's caller listed, and the parent's tools a fork lacks.
  - **What the stream adds at its start:** what actually happened when it was created. That covers which inheritance path ran (cut at the fork call, or the parent's whole compiled context at that moment because the call wasn't in it), its context budget as created, its prose routing when there is no parent stream to inherit it from (no caller, and no configured parent agent registered), and the tools it's shown, as the board stands when the launch composes its context. A fork's tools are compared with what its parent is shown: every tool it lacks is named, and the tools it has beyond its parent's are named up to ten. A spawn's, and a parentless fork's, are listed in full. It also sets the agent settings the stream is created with, which are the framework's defaults, against its parent's or caller's: extended thinking, provider parameters, prompt caching and its TTL, the prefill user message, the same-round think-text policy, refusal handling, and the tool-result and tool-wrapper prose guards. It names each one that differs.
  - **Receipts:** the async receipt says the launch was accepted, and whether it's starting or queued for a slot. A sync result carries the description as `launch`, and a detached return appends it.
  - **The size check:** the prompt-size check before a fork's or spawn's first inference now counts the orientation, since the first request carries it. So a launch whose context sits within the orientation's length of `maxPromptTokens` is refused before it starts, as a prompt over the host's limit, where it used to start.
  - Fork defaults don't change.

- The Web UI's Health tab shows a compression debt that context-manager
  couldn't read in the words of anima-research/context-manager#272's report,
  in the rose it gives a section that couldn't be read, or the alarm's when
  the debt is critical:
  - **A head that says what it means:** compression has stalled, when the
    ledger compression needs can't be read, or the debt can't be checked,
    when the report itself failed, with only the counts the report gave.
  - **The report's message whole,** with its line breaks: what happened,
    what it means for the agent and what to do, a line each.
  - **The host's own next step:** run `/bug`, describing the message in
    your own words, for a fault in the report, or when the store's error
    says its data is damaged, which nothing in context-manager repairs.

  An age past two hours now reads in hours (`oldest 3h`, where it read
  `oldest 180m`). A report from a context-manager before #272 reads as
  before, but for that age.

- A workspace mount passes every key a recipe gives to agent-framework as given, resolving only its path and filling in `mode` (`"read-write"`) and `watch` (`"never"`) where it gives none, as before, so `walkCap`, `followSymlinks`, `watchDebounceMs` and `watchRootPollMs`, which the host had dropped, now reach it (#275). With `followSymlinks` on, the instructions file is still never read through a link that leads outside its mount.

- **`walkCap` on a recipe's workspace mount:** the most entries one walk of
  the mount takes, agent-framework's 5000 unless set, passed to the
  framework as given. A sync that reaches it reports the rest as incomplete,
  and the next sync of the same scope resumes after the last entry it took;
  agent-framework makes that place durable with the store's next sync, so if
  the machine goes down before then, a sync can start again from an earlier
  place. A value that
  isn't a whole number from 1 to 9007199254740991
  (`Number.MAX_SAFE_INTEGER`) stops the recipe loading, with an error naming
  the mount.

### Changed

- **Contributors:** the `typescript` devDependency is now `^7.0.2`, at the root and in `web/`, so typechecking (`tsc --noEmit`) needs TypeScript 7. Its compiler is a native binary, shipped for twenty platforms; on a platform it doesn't cover, such as 32-bit x86, `tsc` has none. Its package has no `tsserver`: its language server runs as `tsc --lsp --stdio` instead. The root `tsconfig.json` now names `"types": ["bun", "node"]`, and `web/`'s names `"types": ["node"]`, since TypeScript 7 no longer includes every `@types` package by default.
- **Installs of the published package:** the postinstall builds the Web UI with `npm --prefix web install`, which installs `web/`'s devDependencies, so `web/node_modules/typescript` is now 7.0.2, with its platform's native binary. An npm install still brings TypeScript 5.9.3 as well, for `bun-ffi-structs`' peer; a Bun install links 7.0.2 to that peer instead, which is harmless, since `bun-ffi-structs` never imports TypeScript.
- **Unchanged:** the host and the Web UI. TypeScript here only typechecks: the host runs its sources under Bun, `web/` bundles with Vite, and the bundle is byte-identical.

- **Anyone who ran the tests, or rebuilt the web UI, from the installed
  package:** the npm package now carries `src`, `recipes`, `scripts`,
  `docs`, `tsconfig.json`, the built web UI and the root docs, and no
  longer the test suite, the web UI's sources, `bun.lock`,
  `CONTRIBUTING.md` or the repository's CI and changelog files. Run the
  tests, or rebuild the web UI, from a checkout. Running the host from
  the npm package, its web UI included, is unchanged.

- An `anthropic-xml` recipe's agent with a system prompt and prompt caching
  now gets its tool definitions in its system block. Membrane's default
  spliced them into the transcript ten messages before its end, a point
  that moves with every message, so the tool block was written to the prompt
  cache again on every turn instead of being read from it (#287). The agent
  now meets its tools at the start of its context, where before it met them
  near the end. Each change of its tool list, as when an MCPL server
  connects or reconnects, writes its whole prompt to the cache once, and so
  does its first request after the upgrade. A recipe whose agent has no
  system prompt, or prompt caching off, keeps its tools where they were. The
  host's subagents take the placement their recipe's agent gets, whatever
  their own prompt or model, and the context panel's exact count builds the
  request the same way.

- **Discord reactions:** connectome-host no longer sets its own
  refusal-only `DISCORD_SUPPRESSED_REACTIONS_BASELINE` on each MCPL child,
  as agent-framework 0.22.1 asks hosts to stop doing, so each stdio child
  gets the framework's derived default. That default also covers the
  awareness emoji (💤) and retained recovery emoji. Suppression is by
  emoji, so members' own reactions with those emoji stop reaching the agent
  too, as reactions with the refusal markers (🛑, 🧠, 💻 and the others)
  already did. discord-mcpl seeds its filters file (`DISCORD_FILTERS_FILE`)
  from the baseline at its first start, so a deployment whose file was
  seeded under the host's old refusal-only baseline keeps that list, since
  the file's `suppressedReactionEmojis` key is discord-mcpl's only authority
  once set. There, members' 💤 reactions keep reaching the agent, and
  discord-mcpl logs at startup that the file lacks entries of the injected
  baseline. Adding those entries to the file gives the default's
  protection. The framework no longer logs, for each child the host starts,
  that its env replaces the protective default. A server's
  own `DISCORD_SUPPRESSED_REACTIONS_BASELINE` with tokens still replaces the
  default, and one without (blank, or commas alone) counts as unset. A
  non-string value counts as its string form, so `false` or `0` replaces the
  default too. For an `inheritEnv` server, a baseline with tokens in the
  host's own environment now replaces the default as well, where the host's
  value used to override it. The host still sets `AGENT_TIMEZONE` on every
  child. A stdio child that takes the default now reads the awareness ledger
  at each spawn, so while the ledger can't be read, its automatic reconnects
  fail and retry, whether or not it's a Discord child.

- **More from agent-framework 0.22.2 that operators may notice:**
  - On a workspace mount of more than 5000 files (links and other entries
    that aren't directories count too), the first syncs and catch-up scans
    after the upgrade catch up on what 0.22.1's walks, which stopped at
    5000, never reached, up to the mount's walk cap in each pass. Each pass pushes one event for each kind of change it
    finds, and where the mount's `wakeOnChange` admits that kind, each
    event is a message to the agent.
  - A coalesced MCPL message with inline images is admitted like any other
    message, where 0.22.1 refused one whose content passed 1 MiB with its
    images.
  - Going back to an earlier connectome-host release, on agent-framework
    0.22.1 (this one requires 0.22.2): if agent-framework logged an
    `[agent-settings]` line saying a setting stays set but unapplied, reset
    it first with the `agent_settings` tool's reset, since 0.22.1 refuses
    to start with it.

- Requires `@animalabs/agent-framework` ^0.22.2 (with `@animalabs/context-manager` 0.14.1).
  On 0.22.1, a kv-unified agent that had saved a budget below its configured one failed to
  start: the boot restore applied it as a paced decrease, which kv-unified refuses, and the
  error escaped `AgentFramework.create()`. 0.22.2 keeps a setting it can't apply at boot set
  but unapplied, and says so on stderr.

- **More from agent-framework 0.22.3 and 0.22.4 that operators and residents
  may notice:**
  - A resident whose context holds a `redacted_thinking` block that
    agent-framework stamped with its token estimate is no longer refused at
    every request until that turn leaves its context (0.22.4). The framework
    stamps a thinking block it stores when the reply's output tokens exceed
    what its visible blocks account for, and the stamp went out with a
    `redacted_thinking` block, which the Messages API refuses.
  - Tool definitions change. The workspace `read` tool's `offset` and
    `limit`, and `grep`'s `contextBefore` and `contextAfter`, take integers,
    the channel and history tools' descriptions are reworded, and a resident
    with MCPL channels configured gains a `drafts` tool (`list`, `read`,
    `resend`, `dismiss`) where its tool rules allow it. So a resident shown
    any of these tools misses the prompt cache once, on its first request
    after the upgrade.
  - Plain speech that routing holds back is kept as a draft its resident
    can read and resend, where only its count was kept.
  - A tool's refusal reaches the model as an error result, such as
    `tune_out`'s, `channel_open`'s on a tuned-out channel and the
    subconscious's refusals, where the model read it as the tool's answer.
  - `skip_reply`'s `wake_in_seconds` takes a number of seconds from 1, as a
    number or as text such as `"90"`, and waits at most 3600. A value it
    can't read that way is refused without ending the turn, and so is any
    value while the recipe sets `modules.wake` to `false`, since nothing can
    then set the timer. Left out or `null`, the call ends the turn without a
    wake.
  - A switch that agent-framework takes as `true`, `false` or `null` (unset)
    stops the boot with the framework's words, naming the switch, when it's
    written as anything else, such as `"false"`. The host's recipe check
    already refuses most such switches. The ones it passes on unchecked are
    an agent's `refusalHandling.autoRewind` and an MCPL server's `reconnect`,
    in `mcpl-servers.json` or a recipe's servers, which 0.22.2 read by their
    truth, so that `"false"` turned them on; and `allowHostCommands` on a
    server only a recipe defines, which 0.22.2 took as granting only when it
    was `true` (`mcpl-servers.json` doesn't carry it). Write `true` or
    `false` without quotes.
  - A stored state that the framework can't read stops the boot, naming it
    and what to do, where it was taken as empty and the next write replaced
    it: the host mode, the queue of deferred context writes, usage totals,
    an agent's persisted runtime settings, tool-result guards, MCPL
    coalescing state and checkpoint trees, and an MCPL feature set's state.
    As before, a record of provider waits that can't be read doesn't stop
    the boot: no provider call is made until it can be read or an operator
    releases the waits.
  - Quiesce writes the queue of deferred context writes first, and is refused
    when the queue can't reach disk. The Web UI shows the refusal in the
    framework's words, which name quiescing with `abandon: true` as a way
    out; the Web UI doesn't offer that.
  - Escape and the Web UI's interrupt also stop a turn at the boundary after
    a round's tools, where the turn went on, and a stop is no longer recorded
    as an inference failure.
  - A file the workspace writes keeps its permission bits.

- Requires `@animalabs/agent-framework` ^0.22.4, which carries 0.22.3's
  changes and one fix of its own. What changes in the host with it:
  - After an interruption, the TTS relay's note to the agent says the posted
    message "could not be trimmed" when the server refuses the edit, where it
    said the message was trimmed to match: 0.22.3 gives a module's `callTool`
    an MCPL server's error result as a failure.
  - The Web UI's agent tree, and a fleet child's agents in the TUI's tree,
    show a turn the framework gave up on (`inference:exhausted`) as failed,
    where they showed it as cancelled: from 0.22.3 a stop or a shutdown ends a
    turn with `inference:aborted` alone, and `inference:exhausted` means the
    turn failed. A turn already stopped stays stopped until its next start,
    so a fleet child the host adopts while the child still runs 0.22.2 shows
    an interrupt's stop as before: 0.22.2's interrupt sends
    `inference:aborted` and then `inference:exhausted`. Until such a child
    restarts on 0.22.3 or later, a subagent it stops shows as failed, since
    0.22.2 ends that stop with `inference:exhausted` alone.
  - An agent overlay entry's `reconnect` written as the text `"false"`, in
    any case and with any spaces around it, is read as false, where its truth
    turned retrying on. Any other value that isn't `true` or `false` is still
    read by its truth, and the startup warnings name each. 0.22.3 refuses any
    value but `true`, `false` or `null`, so the overlay hands it `true` or
    `false`.

- A fork or spawn is now refused when its stream wouldn't read its whole orientation and its whole task in its first context. Each message in a stream's context is capped alone at 10,000 tokens: the cap counts a message's text blocks and string tool results, keeps the message's beginning, and cuts or drops what doesn't fit, while every other block, a tool call among them, passes whole. Before, the launch ran, and the stream read only the part of a long task that fit.
  - **What's checked is the launch's own compile of the stream's context,** which caps and selects the stored messages as its first inference does, not a prediction of the cap:
    - for a spawn or a parentless fork, its orientation and its task, each its own message and whole;
    - for a structural or fallback fork, its result's head (everything through the return instruction), and the whole task in its own fork call. Both the parent's call and the fallback's synthetic one carry it, so a long task alone doesn't refuse a fork that has a call.
    - Before the first request, only the stream's own compression can change that context, and it can reach a fork's call and result only when their result message, with anything added after it before that request, is longer than the stream's 80,000-token recent window.
  - **The refusal names each part that was cut, and what to do:**
    - a long task: shorten or split it, or put the detail in a file and pass the path, giving a spawn a tool that can read it (a fork's own tools must be able to);
    - a spawn's orientation, which names its tools in full: give the spawn a shorter tools list;
    - a fork's orientation: launch it as `subagent--spawn` instead, with a name, a systemPrompt, a short tools list and a task that fits one message and says what it needs to know, since a spawn's task is a message of its own; for a fork that would inherit its parent's context, the refusal adds that a spawn inherits none of it. A fork over the prompt-size limit gets the same way out. A caller whose tool rules don't allow `subagent--spawn` is told to do the work in its own stream instead;
    - a fork whose call, or that call's result, isn't in its first context: the same.
  - **The refusal is never retried, and never read as a rate limit:** it's the launch's outcome, not a provider failure, and it says the launch didn't start, so nothing ran.
  - **Async launches:** an async launch still answers at once with its receipt, which now says it was accepted, and that it's starting or waiting for a slot, rather than that it forked or spawned and is running. Its refusal comes afterwards as the subagent's failure notice, by the path every async failure takes: the notice is added to the primary agent's context, and an inference is requested for the agent that launched it.

- The example recipes in the onboarding and Claude Code ingest guides no longer set `agent.refusalHandling.announceHumanTurns`, and the recipe type marks it deprecated. No agent-framework release has read it, so on any release it changes nothing, and a recipe that still sets it loads and runs as before. The type now lists `retries`, which both guides already set.

- **Contributors, and consumers who typecheck the source with the shipped `tsconfig.json`:** it now sets `isolatedModules`, so `tsc --noEmit` also rejects what can't be transpiled one module at a time, as bun runs the source: a type-only name re-exported without `export type` (TS1205), for one, which bun fails to load. The host's own source meets it.
- **Contributors:** the web app's typecheck no longer checks `src/commands.ts` and the host modules it imports, with Node's types. The `Line` type it took from there moved to `src/output-line.ts`, and `src/commands.ts` still exports it.
- **Unchanged:** what runs.

### Fixed

- The Web UI's alert strip clears a `compression-quarantine` or
  `inference-exhausted` row once its agent leaves the `/healthz` snapshot, as
  a spawned or forked subagent does when it is torn down. Before, the row
  stayed until the page was reloaded, and a quarantine row looks like an
  outage.

- Installed from npm with npm 12 or bun, the host has its web UI: the
  package now carries it built, in `dist/web`, where it used to rely on a
  `postinstall` to build it, which npm 12 and bun don't run for a
  dependency (#276). The `postinstall` stays for checkouts, where `web/` is
  and it builds the web UI. In an install from npm it does nothing, and npm
  12 and bun may report it as blocked; nothing is lost. The host's warning
  and 503 page for a missing web UI now say to rebuild it in a checkout and
  to reinstall an installed package.

- The `notices` module now tells a person who writes to the agent from a
  channel it hasn't opened, such as a mention in a closed channel or a first
  DM, that it can't respond during an outage. Those messages reach the host
  as push events, and the module answered only `channels/incoming`, so such
  a writer was told only when a turn their message started failed (#286).
  A push counts when it's addressed to the agent and tagged
  `chat:from-human`: a bot's mention, or a server's summary of missed
  messages, gets no line. `reply.in`, which matches every channel unless the
  operator narrows it, decides which channels are answered, as for incoming
  traffic. On a Zulip stream the agent hasn't opened, the host can't name
  the topic the person wrote in, so the line lands in whichever topic
  zulip_mcp gives a publish with no routing hints: on its `main` now, the
  topic named `mcpl`.
  The `activity` module takes typing's routing hints, such as a Zulip topic,
  from those messages too, as it takes them from `channels/incoming`.

- The `activity` module now counts a turn as over at `inference:turn_ended`
  (a turn a tool ended) and `inference:aborted` too, as well as at its
  other ends. Before, after such a turn it still counted one as under way,
  so a channel added with `show_in` started showing "typing…" with nothing
  composing. A silent wake, whose prose is suppressed, no longer turns the
  indicator on, as agent-framework's own Discord module doesn't. The module
  also stops listening to the framework's traces when it stops.

- Recipes now validate and forward `agent.allowedTools` (`"all"` or an array of exact tool names), preserving omitted-field defaults and explicit empty lists. Spawned and forked subagents inherit the caller's tool restriction; explicit spawn lists can only narrow it, with `subagent--return` always included. This configures Agent Framework tool visibility; dispatch enforcement remains the framework's responsibility.

- At maximum spawn depth, retain permitted utility names alongside the collapsed `utils` tool, from the utility catalogue (`getAllUtilities()`) of the Framework release from https://github.com/anima-research/agent-framework/pull/220. Explicit lists must name both `utils` and each permitted utility. That release enforces each utility's own name; Framework 0.22.1 has no such catalogue, so there no utility names are retained, and permitting `utils` still permits every utility. This Host correction remains compatible with either Framework release.

- `/bug`'s provider summary and the Web UI's call ledger now read whole `llm-calls.*.jsonl` lines back from a log's end, within 64 MiB: four lines of the writers' 16 MiB bound, and the byte before them. Before, `/bug` read the last 4 MiB of this process's log, and the ledger the last 16 MiB of each of its four newest logs. So one record longer than that left `/bug` with no calls to count, as in a run of failures that keep their requests, and a few long records left the restored ledger without the calls before them. The ledger reads its newest log first, with one budget for all four, so a newest log that fills it leaves the older ones unread. It keeps the newest 200 calls as rows, and still takes every call it reads that read or wrote the cache as its lineage's latest activity.

- The smaller modules' errors now say what was wrong and what the agent
  can do: `activity`, `channel-mode`, `lessons`, `settings`, `notices`,
  `instructions`, `retrieval`, `time`, `tts-relay`, `tui` and `webui`. A
  call to a tool a module doesn't have names the tools it has, from the
  module's own list, or says it has none and where the agent should look
  instead: `agent_settings` for reasoning, the workspace file for
  instructions. Refusals name every wrong argument at once, with the value
  given. A partly applied `channel-mode--set_channel_mode` says what each
  step that worked did, what failed, and how to retry, `debounceMs`
  included; one where no step worked says nothing changed, and one with a
  step that got no answer says it may not have changed. The
  `[host-notice]` marker says the agent couldn't respond only for an
  outage or a failure of the agent's own turns. Another status notice,
  such as a credential expiring, says it was for whoever runs the host and
  needs nothing from the agent, where it used to claim the agent couldn't
  respond; an episode with both gets a marker of each.
- `channel-mode--set_channel_mode` checks `debounceMs` before it changes
  anything, in either mode. Before, a value outside the gate's 100–300000
  ms opened the channel and pinned it open, and only then failed on the
  gate rule; one that wasn't a number, such as `"60000"` or `null`, became
  the default (180000 ms unless the recipe sets another) without a word.
  Both are now refused, naming the value, and in mentions mode, which
  ignored it, a `debounceMs` that's given is checked too. A recipe's
  `defaultDebounceMs` above zero but outside those bounds, which made
  every call that left `debounceMs` out fail, is now clamped to the nearer
  bound; one at or below zero, or not a number, gives 180000 as before.
  Either way, a `[gate]` line in the host's log says so.
- `lessons--create` and `lessons--update` check every field they're given
  before changing anything: content must be text that isn't blank, tags
  and evidence lists of text, and confidence a number from 0 to 1. `null`
  counts as given and is refused; on update, leaving a field out keeps it.
  `lessons--create` needs content and tags, and `lessons--deprecate` needs
  a `reason` that isn't blank. Each refusal names every problem. Before, a
  lesson was stored as given: one stored without tags (or content) made
  every later `lessons--query` by tags (or text) fail, a confidence of 85
  was kept as 8500%, and on update a `null` confidence became 0 and a
  `null` evidence threw after the content had changed.
- `agent_settings`' `reasoning_budget_tokens` must be a number. Before,
  `null`, `true` or `"60000"` was turned into one, and `null` or `true`
  then set the budget to the 1024 minimum without a word.

- A headless host now exits once `headless.log` holds what was written to
  it, waiting at most 2 seconds, after which it says on its stderr that the
  log's last lines may be missing. A graceful shutdown used to exit 50 ms
  after ending the log, and a fatal error after the log opened exited at
  once, so on a busy host a failed stop's line, or the server's error when
  the socket's path was taken, could miss the file. A line written once the
  shutdown has ended the log, such as a client disconnecting, goes to the
  host's stderr; it used to make the log's stream fail, which could end the
  host before the log's last lines landed.

- The health snapshot (`/healthz` and the `health` panel op) reads each agent
  on its own in its per-agent sections: `compressionQuarantine`,
  `compressionDebt`, `contextComposition` and `runtimeSettings`. Before, one
  agent whose read threw dropped the whole section for every agent. That
  happened to `contextComposition` and `runtimeSettings` while an agent's
  context manager wasn't initialized for the current branch: while it
  re-initializes on a branch switch, and, with an autobiographical strategy,
  after a store surgery moves the branch under it, until it re-initializes.
  Now that agent is left out of the section, and the snapshot's new
  `readFailures` names it, by section, with what the error said, cut to 300
  characters. The Web UI's health panel shows those failures, so a failed
  compression-debt read no longer reads as "not reported by this stack".

- The `identity` utilities' errors say whether anything was sent and what to do next, naming the utilities the way the agent runs them (`identity--accept_invite`, through `utils`).
  - `request` with `fromFile` says why a file disk has couldn't be read and what to do: a directory, a link the mount doesn't follow, a link to a file outside the workspace, a file that changed while it was read, or a refusal that is the host's to fix. The upload receipt's new `from` says which copy went: disk's, or the workspace's where disk has no file at the path. Every successful upload carries the receipt, including one whose response was saved with `saveAs` or was binary, and a failure after the workspace's copy went out names that copy. A file over the upload limit is told the limit is fixed, so to send a smaller one. A `contentType` that can't be sent as a header is refused before the file is read. An extension such as `.constructor` gets `application/octet-stream`, as any extension the host doesn't know does, where before the upload went out with an object's text as its type.
  - `request` with `saveAs` is refused before anything is sent when the workspace's write would refuse its path: there's no workspace, no mount has the path, it names a mount but no file, it has an empty part right after the mount's name or a `.` or `..` part, it leads out of its mount, or the mount is read-only. Every path the workspace's write accepts still goes out. Before, the request went out and only then failed to save, so a write's answer was lost.
  - A response that `saveAs` stored in the workspace, with only its copy on disk failed, counts as saved, as agent-framework's `save_recent_image` counts such a file, and the receipt's new `saved.diskCopyError` gives the reason. Before, the agent read that the response couldn't be saved, and could send a write again for it.
  - A write's binary response that isn't saved no longer advises repeating the request with `saveAs`, which would send the write again. It says to pass `saveAs` with the write itself. With a workspace, a GET's note is unchanged; on a host with no workspace, neither note advises `saveAs`.
  - A `request` that got no reply says its outcome is unknown, and to check a write before sending it again. One the service answered, whose response couldn't be read or saved, gives the status it was answered with and says that what the request changed stays changed. Before, a request that got no reply and one whose response couldn't be read both read "<service> request failed".
  - When the identity service doesn't give access, the message goes by its status: a 429, a 5xx or a 200 whose reply can't be read says to try again shortly, and any other refusal points to `identity--status` and the operator. The agent reads these through `request`. The operator reads a sentence of their own in the MCPL dial's log, which a failed access repeats on every reconnect. When the identity key can't be loaded or can't sign, the log names its file and the error, and the agent's message names neither. A key file holding a key of another type than ed25519 is refused where it loads, by `status` too, and left as it is.
  - Calls to the identity service's `/token` and `/enroll` give up after 15 seconds, as its `/services` lookup already did after 5. Before, the host set no limit of its own on them, so a call to one that never answered had no end: the MCPL dial that asked for access waited on it, as a registration did. One that times out before the service answers reads as unreachable for access, and as no reply for a registration.
  - `accept_invite` says what became of a registration. A 429 registered nothing, so it says to try again shortly. With no reply, a 5xx or a 400, whether the service registered the host is unknown, since each can come after the service registered it: the message says how to find out without trying another name, or, for a 400 about the name, to try another. A refusal gives the service's reason and allows for an earlier call that may have registered the host, in the operator's log too. A registration the service answered 200 for, but this host couldn't record (its record couldn't be saved, or no id could be read from the reply), is held until the host restarts, a session switch included, so `status` and access work until then, and the operator is asked to record it before then. A record they write while the host runs is read from then on, and the hold is dropped. Wherever the operator is asked to record a registration by hand, the log says where the record goes and what to write in it. Where this host has no id, that leaves `sub` out and says to add it, so a copy made as written reads as holding no registration. Each registration the host records is logged too, so a later call that registers settles the log. A reply whose body isn't a JSON object reads as naming no id and no reason. A second registration while one is under way is refused, from any session, and told that the first call's answer goes to that call, which may be in an earlier session, and what `status` shows once it ends.
  - A registration record that can't be read now says that whether the host is registered is unknown, and to ask the operator, whose log has the reason. Before, one that couldn't be read or wasn't JSON read as never registered, and its remedy, registering, would be refused. With no record, `status` and access say no registration is recorded on this host, which is what the host knows.
  - A key file missing beside a registration this host records or holds is no longer replaced with a new key, which the service would refuse on every access. The log says to restore the key file, or, to rotate the key on purpose, to remove the record as well (for a registration held in memory, to restart the host) and register again with an invitation code, under a name the old registration doesn't hold.

- A lesson stored without usable content, tags or evidence, as earlier
  versions could store one and a hand edit of the shared lessons file can,
  no longer makes `lessons--query`, `lessons--list` or `/export` fail.
  Every reader, retrieval included, reads a missing field as empty, reads
  a list whose entries aren't all text by the entries that are, and reads
  evidence stored as one value as a list of that one. The stored record is
  left as it is until the lesson is updated, and an update that adds
  evidence keeps every value already stored. `lessons--list` and
  `lessons--query` mark each lesson stored without usable content or tags
  with what's wrong and how to fix it, the host's log names each one in
  one line when lessons load, and retrieval no longer injects a lesson
  with no content. An entry in the shared lessons file that isn't an
  object, or a shared file that holds just `null`, no longer stops lessons
  from loading.
- A lesson stored with a confidence outside 0 to 1, such as 85 meant as
  85%, or with one that isn't a number, is ranked and filtered as the
  nearer end of that range: 85 ranks as 1, the top of the range, beside
  any lesson stored at 1, and one that isn't a number as 0. Text that
  holds a number, such as "0.9", reads as that number. A number in the
  shared file too large for JSON to hold, such as `1e999`, reads as one
  that isn't a number, where it stopped lessons from loading.
  `lessons--list` and `lessons--query` show the confidence as stored and
  say how to fix it, the host's log names it when lessons load, and
  `lessons--boost` and `lessons--demote` leave such a lesson as it is,
  saying to give it a confidence from 0 to 1 first. The TUI's `/lessons`,
  the web viewer's lessons list, headless mode, retrieval and `/export`'s
  markdown show the confidence a lesson is ranked by, the markdown with
  each lesson's mark, and `/export`'s JSON holds the lessons as stored.
- `lessons--update`, `lessons--deprecate`, `lessons--boost` and
  `lessons--demote` refuse an id that's missing, empty or not text, saying
  so, before looking a lesson up. A call with no id used to edit the first
  lesson stored without one, and one with a number reached a lesson stored
  with that number though each tool's id is text. A lesson stored without
  an id, with an empty one or with one that isn't text is marked and
  logged as one no call can name.

- A host no longer writes over a shared lessons file it can't read as a
  lessons file: one that doesn't parse, isn't UTF-8 text, can't be read,
  or isn't an object holding a `lessons` list. It keeps its lessons in its
  own state, names the problem once in its log, says so when the file
  reads as a lessons file again, and writes it again from then on, merging
  in what it holds. Before, such a file was taken for absent, and the next
  save replaced it with the host's own lessons, except one that isn't
  UTF-8 text but still parsed, which was read with its bad bytes replaced
  by U+FFFD and written back that way. A file that starts with a
  byte-order mark now reads, and is written back without it.
- Each call that changes a lesson reads the shared lessons file and merges
  it in first, so the change is made to the newest copy, and stamps the
  change past that copy, so it outranks it whatever the hosts' clocks say:
  a lesson another host added since this one started, or a change another
  host made to the same lesson, is kept rather than written over. Of two
  copies of a lesson, the file's replaces the host's unless the host's is
  newer, so a hand edit that left `updated` as it was is kept. An
  `updated` past `Number.MAX_SAFE_INTEGER`, which no clock gives, counts
  as none.
- A write replaces the shared file whole, through a temporary file beside
  it, synced to disk, given the file's permissions and renamed over it, so
  a write that fails leaves the file as it was, a machine that goes down
  leaves it whole, with the old text or the new, and a link to the file
  stays a link. A file that isn't there yet is made the same way, so a
  first write that fails leaves no file. The file is a new one, owned as
  any new file the writing host makes there, and an access control list or
  other extended attribute set on it isn't kept. It's written in place, as
  before, through a link to a file not made yet, for a file the host can't
  write, which is refused as before, for a file with a second name (a hard
  link), and where, for a file that's there, its directory can't be
  written in or the file is mounted on its own, also in a directory on a
  read-only mount; for the last two, the log says so once, before the
  write. A write keeps the file's other keys and each entry where it
  stood. A failed write is named once in the log and tried again at the
  next change, unless it left the file broken, which the log then says,
  and a write that makes the file because it wasn't there says so. A host
  that stops between making its temporary file and the rename leaves that
  file, `lessons-<random>.tmp`, beside the shared one.
- Hosts stop loading entries without a named id, and keep them in the
  file. A named id is text, not empty, that the file holds once at most
  and the host once at most. An entry without one, or one that isn't an
  object, is written back as `JSON.parse` reads it, and a log line counts
  them at start, and again at a change's read when they've changed. A
  lesson of the host's own whose id another lesson also holds isn't
  written, and the log names it once. Before, the start's merge could
  overwrite or drop a lesson without a usable or unique id. While the file
  holds an id of the host's lessons twice, a change to that lesson is
  refused, since the host can't tell which entry its copy came from. The
  refusal, and the log line for that lesson, say which entry to give a new
  id: the one with the earlier `updated`, or either on a tie, and of three
  or more, all but one with the latest. Done that way, every host keeps
  every lesson unless it holds a change to the lesson that the file lacks.
  A host that read the file while it held the id twice also takes the
  file's copy once the two are resolved, however that was done. A new
  lesson's id is one the host doesn't hold, nor the file when the call
  could read it.
- Every host that shares the file needs this change to keep what the
  others write: a host on an earlier version still writes its own lessons
  over the whole file. Two hosts that write at nearly the same moment can
  still lose one's change, between one host's read and the other's write,
  until the host that lost it next changes a lesson, unless the other
  changed the same lesson with the same or a later stamp. A lesson removed
  from the file by hand comes back while a host holds it: deprecate a
  lesson to retire it. Where the file is written in place, a crash or a
  failed write in the middle of it, or two hosts writing it at nearly the
  same moment, can leave the file broken: every host then names it and
  leaves it alone. Repair it by hand, or move it aside, keeping any lesson
  only it holds, for the hosts to write it again from their own lessons.

- The `mcpl-admin` tools' errors say whether anything changed and what to do
  next, and every result, receipts and `mcpl_list` lines included, names the
  tools the way the agent calls them (`mcpl-admin--mcpl_deploy`), so a
  remedy can be followed as written. The tool descriptions are unchanged but
  for one sentence in `mcpl_deploy`'s: a deploy replaces the server's entry
  whole, so each of its fields goes in every time.
  - A call that fails says whether it changed anything: nothing, or that it
    stopped partway, from the call's own record of its changes.
  - An agent overlay that can't be read stops only the calls that need it.
    Before, it stopped `mcpl_list`, a session-only `mcpl_unload` and every
    other call but a restart. A deploy and an unload that would record
    itself are refused, and the unload's refusal points a loaded server to
    `persist: false`. `mcpl_list` lists the servers, with the sources the
    overlay decides as unknown, and an unload for this session of a server
    that's loaded, or the operator's, goes on. A restart goes on too, and
    its note says that a deploy, and an unload that persists, are refused
    meanwhile. Each tool says it in one wording, an unload that can't read
    the file when it reads it again after the disconnect included: why the
    file can't be read, that the next host start will stop on it, and the
    repair. For a file that isn't valid JSON or holds `null`, the start
    stops until it's fixed, and the repair is to fix it (or have the
    operator fix it), with why not to move it aside. For one that can't be
    opened or read, such as a directory in its place, the start stops while
    it can't be read, and the repair goes by whose failure it is: too many
    files open (`EMFILE`, `ENFILE`) is the host's own and can pass, so the
    call is made again shortly, then the operator asked; any other code is
    the file's, for the operator to fix. The listing's line for an
    operator's `mcpl-servers.json` it can't read gives the same repair, and
    says once that what the list says a start loads holds once a start gets
    past that file, if the file still defines what it did at this host's
    start. Before, a deploy passed the file-system error on with no step.
    The boot, which stops on such a file, keeps its operator message.
  - `mcpl_deploy` names every problem with its arguments in one refusal,
    where it named only the first, so an agent fixes them in one call: an
    argument the tool doesn't take, the id, the command or url, an `access`
    grant the host can't serve, each malformed field, a url that isn't
    `ws://` or `wss://`, and a tool prefix a module or another server holds.
    A credential it would send over `ws://` to another machine is refused
    after that, once the url is known to be valid.
  - `mcpl_deploy`, `mcpl_restart` and `mcpl_unload` now refuse an argument
    they don't take, naming it beside the arguments they take. An agent
    that copies a url entry from its overlay sends `transport`, which
    `mcpl_deploy` writes into each url entry it saves but sets itself.
    `mcpl_unload` also refuses a `persist` given as anything but true or
    false (`null` leaves the default in a tool call, as an unspecified
    field does in a deploy; through `utils`, agent-framework refuses a
    `null` for a true-or-false field before the module sees it). Before,
    such an argument was dropped and the call went on
    without it, and any `persist` but `false` counted as true. So a
    misspelled `disabledTools` left the server with no deny-list, a
    `command` given to a restart left the server running its old one while
    the reply said it had restarted, and a misspelled `persist: false`, or
    `persist: "false"`, made an unload meant for this session persist, with
    nothing said. A restart given one of `mcpl_deploy`'s arguments is
    pointed to a deploy.
  - A url that isn't `ws://` or `wss://`, and a tool prefix that a module,
    a server loaded now, or a server the next host start configures holds,
    are refused before anything is saved. Before, such a url was saved,
    and with reconnect, a url's default, retried in the background while
    the reply said it kept retrying; such a prefix was saved, the connect
    failed, and the next host start stopped on it. An env value JSON can't
    write (`Infinity`, `NaN`), which would have been saved as `null`, is
    refused too.
  - A deploy whose overlay can't be saved names the file, which an error
    from the write itself doesn't, and says no server was connected or
    restarted, and, when the save failed before writing anything, that
    nothing was deployed, with the repair by whose failure it is, as for a
    read. For a save that may have stopped partway (a full disk, say, or any
    other system error that doesn't come before the write), it says what the
    file holds isn't known (its old content, the new content whole, or the
    new content cut short), that `mcpl_list` shows the entries it holds or
    why it can't be read, and that the next host start stops on a file that
    isn't valid JSON. Before, the raw file-system error came through. An
    unload whose record fails that way says the same.
  - A failed connect or restart says the state agent-framework left the
    server in, read rather than guessed: still running its previous
    configuration, no longer loaded (so `mcpl_restart` can't reach it), or
    loaded but down. A restart that leaves the id unloaded gives the step
    that a restart of an unloaded id gives, by what defines it; a deploy
    that does says its entry is saved and loads at the next host start. A
    server of the agent's own that a restart leaves down is pointed to a
    deploy for a wrong command, args or url, with each of its fields, since
    a deploy replaces the entry whole, and to a restart only once the server
    itself is fixed, since a restart reconnects with the configuration of
    its last connect, whether that connect succeeded or not. One the
    operator defines is pointed to the operator for a wrong command, args or
    url, since its args and env aren't shown to the agent and a deploy would
    replace their definition whole; and, with the overlay unreadable, the
    deploy waits until the file can be read. For a server the operator also
    defines, which definition it runs isn't known while the overlay can't be
    read, so the step for each is given, and `mcpl_list` shows which once
    the file can be read; that's so too for one such a restart left
    unloaded. One that a deploy's failed connect or restart leaves down is
    pointed to a deploy again, which applies the saved entry whichever
    configuration the framework holds.
  - `mcpl_restart` of an id that isn't loaded is refused before
    agent-framework is asked, naming the loaded servers and the next step by
    what defines the id: the agent's overlay, the operator, or nothing. It
    replaces agent-framework's "MCPL server … is not configured".
    `mcpl_unload` of an unknown id names the loaded servers too.
  - The advice for a tombstoned server the operator defines routes the
    tombstone's removal to the operator for an agent that can't edit the
    file, and says it takes effect at the next host start.
  - After the module stops, each tool says the tools have stopped, without
    advice to retry.
  - A tool name the module doesn't have is answered with the tools it does
    have, or with its utilities on the `utilities` surface.
  - `mcpl_list` with nothing loaded and nothing in the overlay says no
    server is loaded, where it said none was configured.
- A `mcpl-servers.json` that isn't valid JSON is named by its path in a
  `SyntaxError` that never quotes it, at the boot as well as in `/mcp`, the
  web UI's MCPL edits and `mcpl_list`; one whose root is `null` is named in
  a `TypeError`. Before, JSON.parse's own message came through, which names
  no file and can quote the file's text, a token in an env block included,
  and a `null` root threw a `TypeError` naming nothing. The boot's message
  for such a file changes accordingly. `mcpl_list`, which failed on such a
  file, now lists the servers, with the sources the file decides as
  unknown, and says that the next host start will stop on the file before
  it loads any server, that the file is the operator's to fix, and that
  only the listing reads it.
- An overlay entry that names no command and no url is logged at the boot
  as "it names no command to run and no url to dial", in place of "it names
  nothing to run or dial".

- The web UI's `/files/<mount>/<path>` route, the instructions module and the activity module's origin hint read workspace files through agent-framework's `readFileFromDisk`. It refuses a file that is itself a link unless its mount follows links, and reads a file only if its canonical path lies inside the mount, which it checks after opening the file. Before, the route and the origin hint resolved the path by its text and read it with Node's file calls, which follow any link: a link inside a mount let the files route serve a file from outside the mount to whoever could open it, and let the activity module read the first 2 KiB of such a file for a routing hint. The instructions module checked containment itself, by realpath, before it opened the file. The files route now answers 403 for a path no mount holds or one leading out of it, a file that is itself a link, or one whose canonical path lies outside the mount, 503 for a mount the read refuses as unavailable, and 404 for anything else the read can't give, such as a file that changed while it was read, which before was served as it was read. An answer for a read that was refused gives the read's reason as its body. The activity module skips such a file, and the instructions module injects nothing for it.

- `observers--grant` refuses an `expires` that isn't text, such as a
  number, where it dropped it and saved a grant with no end. It also
  refuses one that has already passed, where it saved a grant the web
  viewer never admits and answered that it would be live within about 3 s;
  given for a key that held a grant, that call ended the grant. And it
  takes an `expires` only as a date in the ISO form, `YYYY-MM-DD` or
  `YYYY-MM-DDTHH:MM:SSZ`, where an offset such as `+02:00` can stand for
  `Z`, and stores it as ECMAScript's own form writes it, with `T` before
  the time and an offset's colon, or a time without a zone as the instant
  this host reads it as, in UTC, so the web viewer reads it as the grant
  checked it. Text in another form was read by a lenient parser, so
  `"3600"` and `"3600."` saved a grant until the year 3600, and
  `"05/06/2026"` one until May 6. What it took before and refuses now: a
  date written another way, such as `"Oct 18 2026"`, `"10/18/2026"` or
  `"2027.01.01"`; a year alone, such as `"2027"`; and a day the month
  doesn't have, such as `"2026-02-30"`, which was read as March 2. A date
  alone means its start, 00:00 UTC. A time without a zone is still taken,
  and read in the host's time zone, as before, then stored as that
  instant, so `Z` or an offset makes it exact. The answer to a grant with
  a date alone or a time without a zone names the instant this host reads
  it as. The grants file is read as before, so an operator's `"2027"`
  written there still reads as the start of 2027. The refusal for a passed
  expiry says that `observers--revoke` ends the key's grants, if it has
  any and none is protected. Absent, `null` or empty still means no end.
- Grants saved before this fix with a dropped `expires` hold `"expires":
  null` in the grants file, the same as a grant meant to have no end, so
  the file can't tell them apart. Whoever runs a host can check each grant
  in the file whose `expires` is `null` or absent, and revoke any that was
  meant to end. In the agent's history, an `observers--grant` call whose
  `expires` wasn't text marks such a grant.
- `observers--grant` and `observers--revoke` name every wrong input at
  once, each with what to give. A revoke given a key or label that isn't
  text, and nothing usable beside it, names the value. A revoke that
  matches nothing names the key or label it was given, and one by a label
  two grants share is refused with each of their keys. A protected grant's
  refusal says it's part of the host's baseline, which only whoever runs
  the host can change or remove, where it told the agent to edit a file it
  can't reach. A write of the grants file that fails says nothing changed
  and the file is as it was, and, when the host has too many files open,
  that it can pass and to grant or revoke again shortly. A read of the
  grants file that fails that way gets the same answer from grant, revoke
  and get, where they asked whoever runs the host to repair a file nothing
  is wrong with. A tool the observers module doesn't have is answered with
  the ones it has, and so is a name the idle-limit module doesn't have,
  with its pointer to `agent_settings`.
- In `agent_settings`, `channel_idle_limits` names every bad entry at
  once, an empty channel id among them, and says the field wasn't changed
  and none of its entries were applied. It says that other settings given
  in the same call may not all have been applied, and that
  `agent_settings` with action `"get"` shows each as it stands.

- Removing `observers.json` now takes every grant in it away within about 6
  s, once two of the web viewer's checks in a row find it gone, and the
  viewer's log says so, with why the file can't be read when it's there but
  unreadable. A file back by the second check, as after an editor's save
  that removes it before writing it, changes nothing. Before, a running
  viewer went on admitting a hello from every grant it had held until it
  restarted, while the `observers` tools already read a missing file as no
  grants. With no grants left, the static app shell needs the password
  again, as on a host that never had the file, and the sessions and open
  connections the file's grants gave end with them. A file put back is read
  again at the next check, and so is one replaced by a file with the same
  mtime, or made unreadable in place, which the viewer used to take for
  unchanged.

- Revoking an observer's grant, its expiry, or removing the grants file
  now ends the sessions and open connections the grant gave: within about
  3 s of a revoke or an expiry, and within about 6 s of the file's
  removal. `observers--revoke` says so. Before, it ended only new ones: a
  session cookie minted at the observer's hello kept the grant's HTTP
  routes for up to 12 hours, and an open WebSocket kept its scopes until
  it closed. A session ends at the check that finds its grant gone,
  whether or not it's used meanwhile. A connection whose grant is gone or
  expired is closed as final, so the web viewer shows the observer as
  denied rather than reconnecting. A grant narrowed in place narrows its
  sessions for good, ending one it leaves with none of its scopes, and
  closes its connections, which connect again with the new scopes. A grant
  given again, or widened, after a check has seen it gone or narrowed
  takes a new hello. An entry the viewer can't use counts as no grant. A
  read of the grants file that fails, as a passing EIO or EMFILE can, now
  counts as a check that didn't find the file, so it takes the grants away
  only if the next check fails too. When it does, the viewer can't tell
  who is granted, so it ends every observer's sessions and connections,
  and viewers stay off until someone reloads them, even once the file
  reads again. A grants file that parses but holds no grant the viewer can
  use, such as one whose `observers` isn't a list, ends every observer's
  sessions and connections at the check that reads it.

- The web viewer reads `observers.json` grant by grant. It admits exactly
  the grants it can use, and its log names each one it can't, by position
  and label: a grant with an unknown scope or no scopes, a key that isn't an
  `ed25519:` key of 32 bytes, an expiry that isn't a date, or a key an
  earlier grant already has. Before, one bad grant made a running viewer
  keep every grant it last read, including grants the same edit had removed,
  and a viewer that started on such a file admitted none. Only a file that
  isn't valid JSON, which may be a save read halfway, still keeps the
  previous grants until it parses; a viewer that starts on one admits none
  until then. A file that's there but can't be read or checked, or isn't a
  grants file, admits none. The viewer reads a file that wasn't valid JSON,
  or couldn't be read, again at each check, and names the problem once.
- A key is the same key in either base64 alphabet, padded or not. Before,
  two spellings of one key counted as two grants, so revoking one left a
  client that presents the other admitted.
- The `observers` tools no longer write over a grants file they can't read.
  Before, when `observers.json` wasn't valid JSON or held a grant the host
  couldn't validate, `observers--grant` replaced the whole file with the one
  new grant, dropping every grant in it, protected operator-baseline grants
  included; `observers--get` listed no observers, and `observers--revoke`
  answered "no matching grant". Now a file the tools can't read as grants is
  left alone, and all three say what's wrong with it. In a file they can
  read, `grant` and `revoke` change only the entries they match and keep
  every other entry and field as found, and `get` lists the usable grants
  and names each one that isn't used. A grant or a revoke acts on every
  entry for its key, a revoke by label included, so no other entry for the
  key is left to be used in place of the one revoked. `observers--grant`
  refuses a key that doesn't decode to 32 bytes, and writes keys in one
  spelling. A number too large for JSON, such as an expiry of 1e309, is
  written back as text rather than as `null`, so a grant the viewer can't
  use doesn't come back with no expiry. A missing file still means no grants
  yet. A link at that path stays a link: one whose file is gone is refused,
  and a write through a live link writes the file it points to, where the
  tools used to replace the link with a new file.
- A grant whose `expires` the web viewer can't read as a date is now a bad
  grant. Before, the viewer never expired it. **Operators:** a hand-edited
  grant with such an expiry now stops being used, and the file's other
  grants still are; the viewer's log names it. To repair it, give `expires`
  an ISO date, such as `2026-12-31T00:00:00Z`, or remove it. An expiry
  that's absent, `null`, `""`, `false` or `0` still means no end, as the
  viewer reads it.
- A file the viewer can't check no longer throws from its reload timer.

- Cancelling a subagent, or all of them with Esc, now reaches one still
  waiting for a concurrency slot, which leaves the queue and never starts,
  one still setting up an attempt, which ends there, even if its setup
  would never finish, and one between attempts, in the back-off before a
  retry or in a rate limit's cooldown, which ends there instead of
  retrying. Cancelling a subagent also reaches its children, those still
  waiting for a slot and those an earlier attempt of it spawned, and the
  interrupt's "N subagent(s) stopped" counts each subagent it stopped
  once, a child stopped through its parent included. Before, a cancel
  reached a subagent only mid-attempt: a queued one started anyway once a
  slot freed, and one between attempts went on to retry. A stuck
  subagent's slot reclaimed between attempts now ends it too, where its
  next attempt used to run without a slot.
- A subagent's retry reports its own result, where it used to report one
  that an earlier attempt returned with `return` before it failed.

- The subagent tools check each input against the type their schemas
  declare before anything starts, and a refusal names every wrong or
  missing input with what to give. Absent or `null` means not given, which
  a required input can't be, apart from `return`'s `result`, whose absence
  still means the subagent's last words; and a whole input that isn't an
  object is refused as such. Before, a spawn without `systemPrompt`
  answered that it was running and then failed on a TypeError, one without
  `task` failed on one too, one without `name` ran as `undefined`, a
  `systemPrompt` of `42` ran with no system prompt, `sync` or `hud`'s
  `enabled` given as `"false"` read as true, an async run's `timeoutMs` of
  `null` ended it at once and one of `"300"` set no limit, `tools` given
  as text failed on a TypeError, `maxConcurrent` `null` set the limit to 1
  and `{}` held every spawn, `return` with a `result` that's an object
  reached the parent as `[object Object]`, a spawn given `"go"` as its
  whole input was spawned as `undefined`, and `return` given `"done"`
  dropped it. With no input at all, `peek`, `concurrency` and `return` now
  answer as with no inputs given, where they failed on a TypeError. Some
  calls that did what was meant by coercion are refused too:
  `maxConcurrent` given as text, such as `"3"`; `sync` given as `0`; and a
  `tools` list holding something other than names, which ran. Ranges,
  empty text and inputs a schema doesn't declare are taken as before.
- A spawn's or fork's failure, in the call's answer and in the async
  notice, says whether anything ran, what ended it and what to do: a run
  that didn't start ran nothing; one that stopped returned no result, what
  it did stays done, and calling again starts its task over. One stopped
  by a cancel or a reclaim before its run began says nothing ran. A prompt
  over the module's limit says what to shorten, or for a fork, which
  carries the whole conversation, to spawn instead. No concurrency slot in
  time says how many run against what limit, and to wait or raise the
  limit; while a rate limit holds the limit, it says only to wait, and how
  the limit recovers when it's below the ceiling. The async time limit
  says how to give a run longer.
- A reclaimed subagent's result opens `[Stopped: it showed no activity for
  over 120 s, so the host reclaimed its slot]`, where it read
  `[Terminated: zombie]`. A peek that finds no subagent by that name says
  it may have finished or not have started yet. A tool the module doesn't
  have is answered with the ones it has.

- A spawn or fork whose name a subagent already has, from its spawn until
  its result has come back, is now refused, naming that subagent and
  whether it's running, waiting for a concurrency slot or finishing. Before,
  it was accepted, and the name then pointed at the second run alone, so
  the first could no longer be cancelled by its name. Names are shared
  across the whole tree of subagents: a fork that forks again can't take a
  name another subagent has at any level, and gets the refusal instead.

- A spawned subagent's retry, or a new spawn or fork run under a name an
  earlier run used, no longer fails with "Ephemeral agent name … is already
  registered or has been used in this framework" when it starts in the same
  millisecond as an earlier attempt. The number that ends every agent name
  the subagent module makes is the time in milliseconds, or one past the
  last name's number once that has caught up with the time, so no name the
  module makes repeats while the host runs.

- The `subagent` module no longer retries a subagent because a word in its
  name or a number in its error looks transient. Before, the module's own
  failures went through the same word checks as a provider's, name and
  numbers included: a prompt over the limit for a subagent named `migrate`
  (which holds "rate") counted as a rate limit, so the module halved its
  concurrency, waited 30 s and ran the subagent again; one named
  `idle-watch` was run again; and a time limit whose milliseconds hold
  "500", such as 1500, was retried from the start. The module's own failures
  now end at once. A framework failure is read without the ephemeral agent's
  name, status codes count only as whole numbers, so a watchdog's "15000ms"
  is no HTTP 500, and a rate limit is read from its phrases ("rate limit",
  "rate exceeded", "too many requests") or its status, so "generate",
  "rated" or "too many tokens" in a provider's error no longer counts as
  one, which halved the concurrency and ran the subagent again.
- A sync subagent still running at its `timeoutMs` (by default the module's
  `maxExecutionMs`, 600 s) now moves to the background, as the tools' schema
  says: the call answers that it moved, and the run goes on and delivers its
  result as a message when it ends. Before, without `timeoutMs` the call
  answered "timed out" at 600 s and the result was dropped; with it, the
  call answered that the run had moved to the background, and a moment later
  it was reported timed out while it went on untracked. **Agents:** a sync
  subagent at its mark now answers "moved to background", and its result
  arrives later as a message.
- An async subagent's `timeoutMs` is now a hard limit on its whole run,
  counted from when it holds a concurrency slot, retries and the cooldown
  after a rate limit included, and the run is stopped there. A run whose
  inference hasn't started by then is dropped by the framework, and one
  whose setup outlasts the limit isn't started; both are reported as the
  time limit. Before, each attempt got the full limit, with its back-off
  outside it, so an attempt that failed with a retryable error 50 s into a
  60 s limit was retried with a fresh 60 s, and the run could last 115 s;
  and at the limit the module stopped waiting while the run went on, tools
  included, with nothing tracking it and its result dropped. A tool call
  already running at the limit finishes, and its result is dropped.
- `subagent--concurrency` with a higher `maxConcurrent` now raises the
  effective limit too, so spawns waiting for a slot start at once. While a
  rate limit holds the effective limit down, it recovers toward the new
  ceiling after successes, and the answer says so. Spawns waiting for a slot
  now also start when successes raise the limit or a stuck subagent's slot
  is reclaimed, and a reclaimed slot is no longer released twice, which let
  more subagents run at once than the limit allowed. A stuck spawn is now
  reclaimed even when a finished fork had its name, and the other way round;
  a run whose agent couldn't be created no longer shows as running, and a
  run that fails while it's being registered releases its slot, which before
  stayed held until the host restarted.
- A `timeoutMs` longer than about 24.8 days no longer takes effect at once:
  it's taken as about 24.8 days, the longest a timer waits.

- `identity--request` with `fromFile` sends only what the workspace mount allows. Before, a symbolic link inside a mount let an upload send a file from outside the mount to a configured service, since the disk read checked only the path's text and followed any link. Uploads now read through agent-framework's `readFileFromDisk`, which keeps the mount's `followSymlinks` policy (off unless the mount sets it) and reads a file only if its canonical path lies inside the mount. A link it refuses, a link leading out of the mount, a directory, or a file over the 64 MiB upload limit is refused, with nothing sent. The workspace's stored copy goes only where disk has no file at the path, and the store holds only what the workspace wrote or took in from inside the mount. Operators running 0.10.2 or earlier should upgrade.

- An upload of a FIFO in a mount waits for something to write to it, where 0.10.2 refused it, until a fix agent-framework is preparing for its next release.

- A fleet's autoStart children launch once the parent's framework has started
  its agents, as the fleet module's description says, instead of while the
  framework is still being built. A child is a host with residents of its own,
  so none of them acts before the parent's agents run, and when building the
  parent's framework fails, no child is launched at all. Children still
  running from an earlier parent are adopted at the same point as before. A
  parent's first turn can now find an autoStart child still starting, or not
  yet listed while its recipe loads. The Web UI's welcome as the host starts
  or switches session waits up to a second for the autoStart children's
  launches to load their recipes, so it gives those recipes as before. A
  child whose recipe takes longer, as one fetched from a URL that stalls can,
  is listed by name, and its recipe comes with the first welcome begun after
  it has loaded, as a reconnect or a session switch brings.

- The fleet tools' errors now say what didn't happen and what the agent can
  call next. A refusal says what didn't happen, such as "Nothing was
  launched" or "Nothing was sent", says what a missing or mistyped argument
  was given, and names tools as the agent calls them (`fleet--status`, not
  "fleet status"). A `dataDir` or `subscription` of the wrong type is refused
  the same way, where one threw and a string `subscription` was split into
  its characters. A name no child has is answered with the names of the
  host's children, and a call naming no fleet tool with the fleet tools'
  names. A child that isn't running is described by how it stopped, and one
  the host has no connection to by its state. A failed launch says whether
  the child has exited or may still be running, and what to do next. A
  `dataDir` the host can't create is refused with its path and error code,
  where the file system's own message reached the agent. `fleet--relay` from
  a child with no finished reply says whether its subscription leaves out
  `inference:speech`, which `fleet--restart` keeps, and otherwise what would
  bring a reply. An adoption after a restart that met a process with another
  pid says that another process serves the child's data directory, where it
  blamed a stale socket. The texts a child's record keeps are reworded the
  same way: `exitReason`, which `fleet--status` shows, as do the TUI for a
  child that has stopped and the `/fleet` console once a child's exit has
  been seen, and `autoRestartStopped`, which `fleet--status` shows. A throw
  that no handler words still reaches the agent as its message.

- A fleet child that fails to start now says why. When a launch fails after
  the child was spawned, unless the host is shutting down and leaves the
  child running, the error from `fleet--launch` and `fleet--restart`, and
  the host's log line for a failed autoStart or autoRestart, quote the end
  of what the child wrote to its `startup.log` during that launch: its last
  20 lines, at most 2,000 characters, under a line naming the file, without
  escape sequences or control characters other than tabs and newlines.
  Before, the agent read only the stage that failed, such as that the child
  exited before its socket appeared, while the cause, such as a recipe
  naming an unset environment variable, a missing API key or an extension
  that failed to import, went only to that file. If the child wrote nothing,
  the error says so, and if the spawn reports that no process started, as
  when the child's runtime can't be found, it says that instead, and the
  name's record no longer blocks another launch. A `startup.log` shorter
  than where the launch began is quoted from its end and said to be
  truncated, another file there is said to have replaced it and isn't read,
  and one the host couldn't open or read is named, with why. The record's
  `exitReason`, which `fleet--status`, `/fleet status` and the TUI show,
  stays one line, and the TUI's fleet view shows a notice of several lines
  by its first line, cut as the alerts beside it are.
- A fleet launch refused because `FleetModule` has no `childIndexPath` no
  longer drops the record of the child it would have replaced, such as a
  crashed child or one restored from the persisted state at the host's
  start.
- A FIFO at a fleet child's `startup.log`, such as one a child left in its
  own data directory, no longer stops the host's event loop at that child's
  next launch. The host opens the file without waiting for a FIFO's reader,
  and gives it to the child only if it's a regular file that took the
  launch's header; otherwise the child's console output isn't kept, and the
  host's log says why at the launch, as does the error of a failed launch
  that would otherwise quote it.

- Reconcile matching stale Fleet child PID and socket artifacts after confirmed owned shutdown, including already exited or crashed tracked children. Existing ownership and live/replaced-artifact checks remain unchanged.

- A launch is refused in a data directory that another of the host's children
  is starting or running in, whether it comes from `fleet--launch`,
  `fleet--restart`, an automatic restart or a host's autoStart. It used to
  start a second child there beside the first, though a child takes its socket
  and pid file in its data directory and unlinks any socket it finds there as
  it starts. An automatic restart refused this way says so in
  `autoRestartStopped`. A launch of a name whose record the host isn't
  attached to is refused the same way while that record says starting or ready
  and its pid is in use, as for a child a host restored at its start before
  the child answered on its socket: it used to start a second copy beside that
  child, or, in another `dataDir`, leave it running untracked. A host
  restoring a record with no usable pid, or one from an earlier boot of the
  machine, marks it `crashed`, as it does one whose pid is gone, so a pid that
  a reboot gave to another process doesn't hold the child's name or directory;
  files the child left in its directory still do, as before. Records keep the
  boot id they launched under, where Linux gives one (`bootId`), and an
  adoption gives a record this boot's; a record without one is placed by its
  start time against the machine's uptime, which a clock stepped by more than
  a minute can misplace. Paths are compared as resolved text, so `data/x/` and
  `data/x` count as one directory, but a path through a symlink doesn't. Files
  another child left in a data directory are said to be that child's, where
  the refusal said the host had no record of a child there.

- Fleet preserves Unicode in child events and parent commands when socket reads
  split a UTF-8 character across chunks.

- A fleet launch whose spawn starts no process now fails at once with the
  spawn's own error and its code, and leaves the child's record `crashed`, as
  a launch that fails later does. A runtime that isn't there, or that the host
  may not run, made the launch wait out its socket timeout, 15 s by default,
  and say only that no process started, while the spawn's error went unhandled
  to the host's stderr; a NUL byte in an argument or an env value, or a
  runtime the system can't execute, made the spawn throw, and left the record
  `starting`. The error now says whose the cause is to fix, as the record's
  `autoRestartStopped` does: a runtime that can't be started is for whoever
  runs the host, and calling `fleet--launch` again fails the same way until
  then. `fleet--launch` refuses a `name`, `recipe` or `dataDir` holding a NUL
  byte before anything starts, naming the field, so a value the spawn refuses
  comes from the host's own configuration, such as an env value in its recipe,
  and the error says only whoever runs the host can change it and restart the
  host. The spawn's message is cut before a value it refused, which for an env
  value could be a secret, since the record's `exitReason` is saved and the
  host logs a failed autoStart's error. An error reported for a child that did
  start, such as a kill that failed, is logged.

- A fork with no parent stream (no caller, and no configured parent agent registered) started with an empty context: no task and no framing. It now starts with its intention and its orientation.

- The call ledger prices Claude Haiku 5.5 by prompt length: $0.10/$0.50 per million tokens for a
  request whose prompt, counting its cache reads and cache writes, is up to 100,000 tokens, and
  $0.50/$2.50 over that, with cache reads at 0.1x and writes at 1.25x (5m) and 2x (1h) in both.
  It matched no entry, so its calls showed no cost. After a restart, the Haiku 5.5 calls the
  ledger reads back from the recent call logs are priced too. The pricing version is now
  `anthropic-public-2026-10-19`.

- Headless shutdown now exits with status 1 when framework shutdown rejects, while retaining its diagnostic log and socket/PID cleanup.
- Fleet retains parent-exit child cleanup and its context during pending or failed shutdown, reports child cleanup failures, and still preserves children on intentional detach.
- Accept immediate shutdown after IPC ready, including before the listen callback resumes.
- TUI quit propagates framework shutdown failures after terminal cleanup so the host exits unsuccessfully instead of leaving its exit promise pending.

- Anthropic cache-keepalive sends now appear in `llm-calls` logs and the live/reloaded spend ledger as `keepalive` calls, including ineffective cache writes and errors. Rows preserve terminal vendor usage, split cache-write buckets, and pricing metadata. Existing keepalive callbacks remain composed and isolated; replay payloads are unchanged. Requires a membrane release containing antra-tess/membrane#87. One row represents one logical keepalive send, including any SDK-internal retries, rather than one row per HTTP attempt. A failed send's error is bounded and classified as a complete or stream call's is, as far as the error carries a classification. `/bug` counts these sends among its provider calls and lists a failed one's kind as `keepalive`. The Health call table shows these rows as `keepalive`, in a muted tone of their own.
- A keepalive send's row keeps the request it replayed only with `LLM_CALLS_FULL_PAYLOADS=1`, a failed or refused send's too, where a failed or refused turn's row keeps its own. membrane replays a lineage's latest real request every refresh interval, so keeping it in each such row would write the same request again and again.
- The call ledger measures each call's cache gap within its cache lineage, membrane's key for its model, system and tools, where it used one clock for the whole process. So another lineage's calls or keepalive sends no longer make an expired cache read as a changed prefix, for any of the 256 lineages last active that the ledger remembers. A restart's reload remembers the lineage of every call it reads that read or wrote the cache, not only the rows it keeps. A lineage it doesn't hold, as after a change to the system prompt or the tools, is measured from the last cache activity of any, so a changed prefix still reads as one while that gap is inside the call's TTL, and the cause says the gap is any lineage's: a changed prefix, a new agent's first call, or a lineage last active before what the ledger holds. The request summary of each complete, stream and keepalive row names its lineage, unless the call failed before membrane built its request.
- The credential monitor now hears keepalive sends as it hears turns: a send the provider rejects for its credential raises the auth alert while the resident is idle, rather than at its next turn (membrane keeps poking an idle lineage for a day after its last real request by default), and a send that succeeds settles an auth alert as a successful turn does.
- A refused keepalive send is logged and raises no alert. A turn the provider then refuses is handled as any refused turn is: agent-framework records each one, and alerts from the second in a row. The off-path refusal alert for a refused `complete()` call, such as compression's, now puts the call's kind under `call` in its data, so `failures.log` keeps `refusal-offpath` as the record's kind, and its size is the whole prompt, cache reads and writes included.
- `connectome-doctor`'s inference stage skips keepalive rows, so it reports the last real model call and its time rather than the last poke. It prints an error row's message, where it printed the error object. It splits the log at newlines only, so a row holding U+2028 or U+2029 is no longer lost (the diagnostics dump's read too). It counts the rows it couldn't read since the last turn it could, and says when the last row is incomplete (a last row that parses without its newline counts as a row). Its warning after a triggered ingest now says no turn was recorded after it, rather than that no inference followed, since logging is best-effort. It looks for a turn, a stream call, rather than any call (rows don't say which agent's, so a subagent's stream call counts), and holds back when an unreadable or incomplete row that may be newer than the ingest could be that turn, or the ingest is older than its window.

- Per-call `llm-calls.*.jsonl` records from all three writers (Anthropic, Bedrock and the generic provider wrapper) now stay within 16 MiB of UTF-8 per line, newline included. An oversized or unserializable record drops its raw request first, then its raw response only if the line still doesn't fit, so a call's usage and stop reason usually stay, then its summaries, keeping its type, kind, timing, error and classification, and `truncated` says what was dropped; ordinary records are written unchanged. Previously only the generic wrapper had a guard, which counted UTF-16 units and did not recheck its fallbacks, and an Anthropic or Bedrock record with an unserializable body was lost.

- **A path in another mount's directory nested in the one named,** which agent-framework refuses as `other_mount`, naming the path to use, from its release with anima-research/agent-framework#460. With that release installed, the web UI's `/files/` route answers it `403` with that reason, where it would answer `404`, and an identity upload's refusal gives that reason alone, where it would say a workspace copy wasn't sent in the file's place and send the agent to its operator.

- The call ledger prices Claude Opus 5.5 at $4/$20 per million tokens with cache reads at
  0.05x ($0.20). It had matched the Claude Opus 5 entry and was priced at $5/$25 with 0.1x
  reads.

- **Agent overlays:** an `mcpl-servers.agent.json` entry's
  `allowHostCommands` is left out at boot, as its `inheritEnv`,
  `enabledCapabilities` and `toolLifecycle` already were, so host commands
  are granted only by the operator's own config: an operator who granted
  them through the overlay sets `allowHostCommands` in a server the recipe
  defines itself, with its own command or url and an id
  `mcpl-servers.json` doesn't define, instead. The startup warnings now
  name each of the four that an overlay entry sets, with where the
  operator sets it, and for `enabledCapabilities` how the entry can narrow
  what its server advertises instead: by listing what to deny in its
  `disabledCapabilities`. They also name an overlay entry's `reconnect`
  that isn't true or false, which is read as its truth, apart from the text
  `"false"` in any case and with any spaces around it, which reads as false,
  and handed to agent-framework as `true` or `false`, so its setup-failure
  trace reports `willRetry` as the connection retries. An overlay entry
  that replaces an operator's server is also named for the operator's host
  commands, capabilities and tool lifecycle it lacks, as it was for env and
  the inherited environment.

- The compression-quarantine alert, as an ops alert (and so in the status-channel posts that relay it) and in the Web UI's alert row and Health tab, no longer calls quarantine records chunks. One quarantined span can hold several records. The alert counts records, and once context-manager's quarantine status lists its spans, it counts those, with the records beside them. A list whose length can't fit the records, empty while records are held or longer than them, is set aside, and the records are named. context-manager's own stderr line for the same alarm is context-manager's, and this doesn't change it.

- A session switch goes on when the current session's framework stops but
  reports a failed teardown. From agent-framework 0.23.0, `stop()` rejects
  after its whole teardown when an MCP server's child couldn't be confirmed
  exited, and a switch from the TUI, the Web UI or a piped command ended
  there: the old session's framework was stopped and no new one started, so
  the agent was gone until the host restarted. The rejection, which names
  each such child, is now logged, and the new session starts.

- A peek at a subagent, and a fork's read of its parent's context, now
  compile that context dry. Each compiled it for real, which commits fold
  resolutions and chunk records and queues compression, though nothing sends
  that compile. By context-manager's contract, a dry compile gives the same
  messages and commits nothing, apart from releasing a compression hold past
  its deadline, as any compile does. Its one other difference is that it
  returns a plan over budget where a real compile refuses it. These reads
  compile at context-manager's default budget, so for a context whose plan
  is over it, a peek now shows the plan's message count and last message,
  where it showed none, and a fork now goes ahead from its parent's plan,
  where it failed, if its own launch check, still a real compile, passes.

- The TUI's status line, the Web UI's streaming message, piped mode's wait for a line's answer and the TTS relay's activation now end at every end agent-framework sends for a turn. A turn a tool ended (`skip_reply`, `sleep`, a subagent's `return`) used to leave the TUI's status line showing the turn, the Web UI's message streaming so that the next turn's text joined it, piped mode waiting out its 120-second cap, and the relay's activation open. A turn that was aborted, or whose stream something other than the framework cancelled, now returns the TUI's status line to idle with a line saying how it ended, where the line went on showing the turn, unless its last attempt failed with no retry started since, when that failure's error line stands for it.
- The Web UI's main view follows the agent whose conversation it shows. A sync subagent's text and tool calls no longer appear in that agent's streaming message, and a subagent's completion or failure no longer ends the message in the middle of the agent's turn. Another of the host's own framework agents, such as a subconscious or a conversation fork, whose stream used to join the main view, now has a stream panel of its own on its node in the tree, showing its stream from when the panel opens. The page still re-reads the host's serving state at any agent's end, since a quiesce drains when the last turn ends.
- Stream panels show a line when a turn a tool ended, an abort or a turn the framework gave up on ends a stream, a subagent's included, and skip the content-block and usage bookkeeping that an agent's own traces carry. Each shows at most 2,000 lines, counting lines rather than their length: its newest, and once it lets older lines go, a first line saying how many it no longer shows. The TUI's subagent peek view shows those ends too. A panel for one of the host's own agents shows the tool calls it makes but not their results, since the framework's tool traces don't name an agent. An open panel (stream, usage or branches) closes when the session switches, since it shows the old session's node or branches. A new session's agent or subagent of the same name no longer adds to the old stream's lines.
- Piped mode waits through a failure the framework retries or holds, so a line's turn answers before the next line is sent, where the next line used to go in as the failure printed. A turn held longer than the 120-second cap still lets the next line in, with a line on stderr saying so. A primary turn that is aborted, or that the framework gives up on, prints a line saying so, unless its last attempt failed with no retry started since, when that failure's error line stands for it. After `/session new` or `/session switch`, piped mode follows the new session's turns, where its next line waited out the cap.
- Outage notices take a turn a tool ended as the agent answering again, as they take a completed turn: an outage with no clear of its own (`hard-down`, refusals) closes, and the channels that were told hear that the agent is back. An aborted turn no longer counts as a failed one, so during an outage the channel that woke it isn't told the turn died.
- The TUI's Escape and the Web UI's interrupt abort the turn through the framework: at once while its model call is in flight, and a turn still compiling its context, waiting to try a failed attempt again, or running tools between model calls, as soon as it can be aborted: at its next model call, once its stream has started, as Escape's line and the interrupt's reply say. Escape used to say `(interrupted)` while such a turn went on, and did nothing while the status line read error, including while a failed attempt waited to be tried again. It now acts on an error while the TUI follows the turn as running; an error shown with no turn running stands as before. While a session switch is under way, Escape now does nothing, where it said `(interrupted)` and set the status line to idle. When the status line shows a turn the TUI follows none of, as after a message is sent and before its turn starts, Escape interrupts nothing, and now says so. The status bar offers Escape where it acts. Every surface sees the interrupt as an abort, so the outage notices no longer tell the channel that woke the turn that it died. Escape no longer resets the agent with `cancelStream`, which it did whenever it acted. Both also take the subagents' turns to the framework the same way before they stop the subagents' runs, since stopping a run ends a subagent's turn only while its stream is open: one whose model call was in flight before its first token, or that was compiling, waiting to try again or running tools between model calls, went on.
- Messages that change or are new, for anyone who matches on them:
  - the TUI's Escape: a turn it aborts at once ends with `(turn aborted: interrupted from the TUI)`, followed by `(2 subagents stopped)`, say, when it stopped any; one it can't abort yet gets `(interrupting: the turn stops as soon as it can be aborted)`, with `; 2 subagents stopped` before its closing parenthesis when it stopped any, and `(turn aborted: interrupted from the TUI)` once the abort comes; `(interrupted)`, or `(interrupted — 2 subagents stopped)`, which Escape always said, is gone: when the status line shows a turn running and the TUI follows none, Escape says `(no turn interrupted)`, or `(no turn interrupted — 2 subagents stopped)`;
  - the TUI's status bar shows `Esc:stop` while a failed attempt waits to be tried again, and, since the TUI can't tell them apart, after the framework drops that retry with no trace, until the agent's next turn ends; it no longer shows `Ctrl+B:bg Esc:stop` while a session switch is under way;
  - the Web UI's interrupt reply names the agents whose turns stop only once they can be aborted, as in `interrupted — main stopping as soon as its turn can be aborted` (`their turns` for more than one), after `<N> subagent(s) stopped; ` when it stopped any, and says `no turn interrupted` when it aborted, kept and stopped nothing, where it said `interrupted`;
  - piped mode prints `(no answer after 120 s: going on without it)` on stderr when a turn passes its cap, `(turn aborted: <reason>)` after a primary turn that's aborted, and `(turn ended: <error>)` after one the framework ends with `inference:exhausted`, as the TUI's status line does, unless its last attempt failed with no retry started since, when its `Error:` line stands for the turn;
  - a failed or ended turn's error reads `Unknown error` on every surface when the framework's is missing, empty or not text, where piped mode and the TUI printed `undefined` for a missing one and the stream panels printed nothing.

## 0.10.2 — 2026-10-14

### Fixed

- Depend on released `@animalabs/agent-framework` 0.22.1.
  - **Provider waits:** a provider's stated `retry-after` now holds the
    agent's turns, recorded in the store and kept across restarts. Under
    agent-framework 0.22.0, which 0.10.0 and 0.10.1 lock, a long
    `retry-after` was slept inside the turn, and stopping the host couldn't
    end the sleep. A wait longer than an hour raises a `provider-wait` ops
    alert. If the recorded waits can't be read, no resident's or
    conversation agent's provider call goes out until they read again
    (tried every 30 s), and a `provider-wait` alert for agent `framework`
    says so. agent-framework's `release-provider-wait` host command lifts a
    wait, and lifts that hold one agent at a time, for the life of the
    process. connectome-host has no TUI or Web UI command for it, so it is
    sent by an MCPL server allowed to send host commands. These alerts reach
    `failures.log`, the TUI's alert lines and the ops webhook when one is
    configured. connectome-host's channel notices give `provider-wait` no
    tier by default, so they don't post them.
  - **Subagents:** a subagent is an ephemeral run, which sleeps a provider's
    stated wait of up to ten minutes and now ends at once on a longer one,
    or on one it can't read as a number, its error naming the wait. Under
    agent-framework 0.22.0 it slept a long wait whole. The subagent module
    now fails such a subagent without restarting it, since a restart would
    only call the provider again too soon. Other rate-limit errors are still
    retried.
  - **A misspelled model:** its 404 no longer sheds the agent's newest
    exchanges.
  - **Failure text:** a provider error that echoes the whole request no
    longer lands in the agent's context whole: the `[inference-failed]`
    marker carries an excerpt of at most 600 characters.
  - **Rollback and suppress:** a live rollback, a suppress or a
    message-granular undo answers once the change has landed, and the
    awareness reactions it schedules are delivered in the background.
  - **Discord reactions, unchanged:** agent-framework 0.22.1 also derives a
    reaction suppression default for each stdio MCPL child, covering the
    awareness emoji (💤 unless configured otherwise) and retained recovery
    emoji, and asks hosts that set the old refusal-only default to stop.
    connectome-host still sets its own refusal-only
    `DISCORD_SUPPRESSED_REACTIONS_BASELINE` on each child in this release,
    which replaces that default, so the reactions residents see don't
    change. The framework logs this whenever it adds a stdio server, at
    startup or at runtime: "DISCORD_SUPPRESSED_REACTIONS_BASELINE from its
    env replaces the framework's protective default".
  - **Going back:** agent-framework 0.22.1's notes say going back to 0.22.0
    is safe. 0.22.0 opens a store 0.22.1 wrote and ignores the recorded
    waits, so a long `retry-after` is slept inside the turn again, and a
    wait recorded before going back binds again if you return to 0.22.1
    before it passes. The notes list three cases as not tested: going back
    while the recorded waits can't be read, going back after an operator
    released a wait under 0.22.1, and going back under connectome-host
    rather than a bare framework.

## 0.10.1 — 2026-10-13

### Fixed

- A recipe with `agent.formatter: "anthropic-xml"` runs as a prefill transcript
  again. Since membrane 0.5.87 a formatter built without a tool mode leaves the
  mode to membrane, which picks native whenever the formatter supports it, and
  `AnthropicXmlFormatter` does. On 0.10.0 such an agent's requests became a
  native chat (alternating turns, native tool definitions, no assistant
  prefill, no speaker stop sequences), and so did its compression calls. The
  host now builds the formatter with `toolMode: 'xml'`, as the recipe's
  `anthropic-xml` promises, and the makeup panel's count does the same.

## 0.10.0 — 2026-10-13

### Added

- Recipes can tune `agent.strategy.maxLiveImages`, `imageStripDepthTokens`, and `maxLiveImageBytes` for autobiographical and frontdesk strategies. Values must be non-negative safe integers; zero disables the corresponding limit. Omitted values keep context-manager's defaults.

- `/bug <what happened>` assembles a bug report for connectome-host's public
  issues. It shows the report, saves it under `DATA_DIR`, and gives a link
  that opens GitHub's new-issue form with it filled in. Nothing is sent: the
  reporter reads it in the form and submits it under their own GitHub
  account, so it needs no credentials of the host's.
  - Besides the reporter's own words, the report holds only fields with a
    known shape: versions and commit, runtime and mode, the setup as
    structure (provider, a model id only when every word of it is a public
    model name, built-in modules, budgets, each MCP server by ordinal with
    its kind, transport and state), this process's provider failures as
    classifications, and this run's host errors as known class names and
    code locations in our own packages.
  - No log line, error message, request, response, prompt or recipe text is
    copied, into the report or the saved file, and no name a user chose
    (recipe, servers, custom modules, custom models, other packages), nor
    commands, arguments, URLs, env values or paths outside our own code.
    The error logs and provider errors can quote conversation text, so they
    are read only for these shapes.
  - Only a person runs it: the fleet's command tool refuses `/bug`.
  - A new issue form, `.github/ISSUE_TEMPLATE/bug_report.yml`, labels these
    reports `bug`.
  - `headless.log` now marks where each run begins, as `tui-error.log`
    already did, so a report reads only the current run's errors.

- Recipes can set **`agent.strategy.carrierPolicy: "live-strip"`** (context-manager
  #81, shipped since context-manager 0.8.0, but never reachable from a recipe
  until now). `'live-strip'` omits a summary's signed reasoning carriers
  (`responseContent` thinking blocks) from the agent's own live-compiled
  window only — compression/merge requests still carry them unconditionally,
  where they're measured load-bearing for some providers. Useful when a
  provider's classifier treats a compressor-signed reasoning block replayed
  inside the live window (rather than the request that minted it) as
  reasoning extraction. Default `'full'` is unchanged/behavior-preserving.

- `openai-codex` can run through an inference gate that holds the ChatGPT
  logins (the gate's `/codex` leg): set `CODEX_GATE_TOKEN` and point
  `CODEX_BASE_URL` at the gate. No Codex CLI or login runs on the host, the
  gate chooses the account, and a gate token is never sent without an
  explicit `CODEX_BASE_URL`. The subscription quota meter is off in this
  mode (the gate tracks utilization per login).

- Recipe `agent.strategy.compressionToolProseFallback: { intoTool, fromTools,
  field?, result?, minChars? }` — validated loudly (a malformed value is an
  error, never a silently disabled rung) and passed through to Context
  Manager's tool-prose hoist fallback, which retries a refused L1 compression
  with long `fromTools` arguments (e.g. a diary kept in `skip_reply.reason`)
  moved into calls to a note-taking tool the agent really has
  (agent-framework's `journal`). Requires the context-manager and
  agent-framework versions that carry the rung and the tool.

- **Subscription credential alerts with operator actions.** A host on a
  subscription credential (`ANTHROPIC_AUTH_TOKEN`, the new
  `ANTHROPIC_OAUTH_CREDENTIALS_FILE`, or provider `openai-codex`) now names
  what is wrong with it — `quota-spent`, `quota-unreadable`, `auth-expiring`,
  `auth-expired`, `auth-rejected`, `auth-login-required` — through the
  existing ops-alert pipeline (failures.log, `ops:alert` trace, webhook), so
  the TUI status bar, the WebUI alert strip and fleet parents all see it. Each
  alert carries the actions the host can run for it; the WebUI renders them
  as buttons on the alert row and in a new Health-tab credential section, the
  TUI names the matching `/auth refresh | login | recheck | token <tok>`
  command. Nothing rotates on its own: membrane's 401 retry gets the same
  token unless `ANTHROPIC_OAUTH_AUTO_REFRESH=1`. A credentials file with a
  refresh token (Claude Code's shape, or flat `accessToken`/`refreshToken`/
  `expiresAt`) makes the Anthropic credential host-rotatable and warns 30 min
  before expiry; a bare token offers "paste new token" only. New panel ops
  `credential` / `credential-action` (WS `request-credential` /
  `credential-action`, HTTP `GET /credential`) work fleet-wide over the
  panel IPC. The header quota readout now says `quota: unreadable` instead
  of rendering nothing when a subscription meter has never read. Behind an
  inference gateway the surface narrows to what the host can actually do: a
  Codex host on `CODEX_GATE_TOKEN` gets an observe-only credential source
  (a gate 401 raises `auth-rejected` naming the gate, Re-check only), and an
  Anthropic host on a gate API key gets no credential monitor at all.
- **Activity module: honest typing.** The typing indicator now also stops on
  `inference:failed` / `inference:exhausted`, not only on a completed turn.

- `modules.history` accepts an object form, `{ semantic: { url, token?, namespace?,
  syncIntervalMs?, maxSyncPerTick?, maxSyncBeforeSearch?, includePrivateTools?,
  allowInsecureHttp? } }`, which adds `history--semantic_search`: meaning-based
  search over the agent's raw messages and compression summaries via a shared
  remote embed-service (agent-framework#173). **Requires
  `@animalabs/agent-framework` >= 0.20.0**; startup throws if the installed
  HistoryModule offers no `semantic_search`. `token` goes through the recipe's
  `${ENV}` substitution. The index namespace is always `<prefix>/<session id>`;
  `namespace` sets the prefix (default: the agent name). Validation is loud at
  load: unknown keys at either level, a URL without a host or with
  credentials/query/fragment, plaintext http outside loopback/tailnet without
  `allowInsecureHttp: true`, budgets below 1, and `syncIntervalMs` other than 0
  or >= 5000 all fail the recipe.

- Recipes can set `agent.thinking.effort` before the first Anthropic streaming request, for example `"thinking": { "enabled": false, "effort": "medium" }`. The recipe remains the effort baseline across unrelated settings updates and restarts. Explicit agent effort overrides it until reset, including an explicit `"default"`; legacy saved `"default"` is treated as unset. A model that doesn't accept the effort level, such as Sonnet 4.5, Haiku 4.5 or a Claude 3 model, gets no effort and its default applies, with a line on stderr. Subagents stream through the same provider adapter, so on a model that accepts the effort they run at the recipe's effort too, as they already did at an effort the agent set. Other providers ignore this field; OpenAI recipes use `agent.responses.reasoningEffort`. Compression calls are unaffected.

- Recipes can set membrane `MockAdapter`'s timing and scripted replies under
  `agent.mock`: `completeDelayMs`, `streamChunkDelayMs` (non-negative
  numbers), `streamChunkSize` (positive integer) and `responseQueue` (non-empty
  strings, returned one per provider call before the echo or
  `defaultResponse`). Offline runs can now reproduce delay-sensitive behavior
  such as event coalescing during a slow turn. Unknown keys under
  `agent.mock` join the recipe's unknown-key warning.

- **Outage notices: the host speaks in the agent's channels when the agent
  cannot.** New opt-in `modules.notices`, a sink of the framework's
  `ops:alert` stream. Each alert kind resolves to a tier — `reply` (hard-down,
  spent quota, expired/rejected credential, pending login, provider hold),
  `status` (context refusal, MCPL server down, unreadable quota, expiring
  credential, …) or `silent` (refusals, unknown kinds) — overridable per kind
  with `*` globs (`"auth-*": "reply"`). For `reply` kinds, a person who writes
  to the agent during the outage gets one canned host-attributed "cannot
  respond right now" line per episode in channels matching `reply.in` minus
  `reply.not` (channel-id patterns: `zulip:*`, exact ids — "notify on Zulip,
  never on Discord" is one line), the channel whose message triggered the
  failing turn is told the same, and every channel told gets one "can respond
  again" line on recovery. `statusChannels` get the operator-grade message
  (kind + error text) for `status` and `reply` kinds after `quietMs` (default
  60 s) without a clear. Episodes close on the kind's `-clear`, on the agent's
  next completed inference for framework kinds that have none, or on
  reconnect for `mcpl-down`. A notice whose chat server is itself absent is
  parked and delivered if the server comes back while the outage is on. One
  chronicle marker per episode tells the agent the host spoke for it. The
  recipe validates channel lists, tiers and timings at load.

- Operators can see each tool's effective MCPL class (RFC-008) and where it
  came from: the recipe's `toolClassOverrides`, the host's own table, the
  server's `_meta["mcpl/class"]`, or nowhere (unclassed). The new
  `/tools [agent]` command lists them in the TUI, readline, web UI and
  headless; `GET /debug/tool-classes[?agent=]` (also a `tool-classes` panel
  op, so `?scope=<child>` works) serves them as JSON; the web UI's MCP tab
  shows per-source counts and the per-tool list; and the agent's `mcpl_list`
  groups each server's tools by class and source.

- Recipes and `mcpl-servers.json` can grant an MCPL server MCPL tool-lifecycle
  observation (RFC-007) with a `toolLifecycle` block on its entry
  (`observe`, `inputs`, optional `tools` / `classes` / `conversations`
  narrowing, `maxInputBytes`). The block is validated at load: an
  "off-looking" value such as `observe: false` is an error, not a grant.
  `toolLifecycle` is also a recipe-overridable field for servers taken from
  `mcpl-servers.json`, which previously dropped it.
- Recipes can set `toolClassOverrides` (tool-name pattern → RFC-008 classes)
  to class third-party MCP tools. The host now passes the classes of its
  own module tools (`HOST_TOOL_CLASSES`) to the framework. Both need an
  agent-framework release that includes tool lifecycle (#199); older
  frameworks ignore them.
- Servers an agent deploys for itself (`mcpl-servers.agent.json`) are denied
  `toolLifecycle`, and any `toolLifecycle` block in the overlay is stripped:
  observing other tools' calls stays an operator grant.
- A recipe `mcpServers` entry may now name a server from `mcpl-servers.json`
  by id with only policy fields, and no `command` / `url`. Validation used to
  reject this. An id-only entry the file doesn't define is a startup error
  rather than being silently skipped.

- WebUI: "⤢ all <tool>" on any tool block (and "all thinking" on thinking
  blocks) expands or collapses every block of that kind across the loaded
  history; individual blocks can still be toggled against the kind. The
  older-history control gains bulk loads (200 / 1k / 5k / all, chained in
  server-sized pages with progress and a stop button) beside scroll-to-load.

### Changed

- Depend on `@animalabs/agent-framework` ^0.21.0 and `@animalabs/context-manager` ^0.13.0. AF 0.21.0 lets stdio MCPL children inherit CA-bundle and proxy variables again (lost in 0.20.0's env allowlist); CM 0.13.0 adds optional compression-hold timeouts and render/diagnostic fixes.

- **The recipe `conversations` block is deprecated** (per-channel conversation
  routing, agent-framework#235). Its `'mention'` bind/trigger rule, the default
  for channels, reads `metadata.mentioned`, which discord-mcpl does not set, so
  on Discord channels an @-mention neither binds a fork nor triggers a bound
  one. Behavior is unchanged: routing still works, and the host logs one
  `[deprecated]` line at startup when a recipe sets `conversations`
  (`deprecatedConversationsNotices()` in `recipe.ts`). `Recipe.conversations`
  and `RecipeConversations` carry `@deprecated`, and the `idleTtlMs` docs now
  note that expiry is checked at most about once a minute, so the sweep usually
  notices an expired binding up to ~60s after the TTL; that is not a deadline
  for closing the fork, whose closure turn can be delayed further (e.g. while
  the host is quiesced).

- Depend on released `@animalabs/agent-framework` 0.18.0 and
  `@animalabs/context-manager` 0.11.0. kv-unified compiles no longer grow with
  the summary forest once a provider cache is relevant (CM #105/#110): on a
  production store, turn 2 went from out-of-memory at 6 GB to about 200 ms.

- Depend on released `@animalabs/agent-framework` 0.19.0. MCPL servers that
  announce a new channel from inside a tool call no longer deadlock against
  the host (agent-framework #160): in zulip-mcp, a stream the bot joined after
  startup stayed `Unknown channel` until a restart. Also brings the private
  `journal` tool beside `think` and `skip_reply`.

- Depend on released `@animalabs/agent-framework` 0.22.0,
  `@animalabs/context-manager` 0.14.0 and `@animalabs/membrane` 0.5.87.
  - **Prompt cache, once:** agent-framework 0.22's workspace tools (`ls`,
    `glob`, `grep`, `sync`, `materialize`, `delete`) have new descriptions and
    parameters, so the first request after the upgrade misses the cache from
    its tool block on.
  - **Workspace:** listings report what is on disk, `sync` without a path no
    longer replaces a workspace draft, and `materialize` no longer overwrites a
    file another writer changed (agent-framework 0.22's changelog has the
    details).
  - **Stores:** under `kv-unified`, context-manager 0.14 stores its
    presentation receipt run-length encoded, so `records.log` no longer grows
    quadratically with session length. Stores written by 0.13 still load.
  - **Makeup panel:** a native agent's exact count now carries its
    `prefillUserMessage` as the synthetic leading user turn, because membrane
    0.5.87's native formatter sends it there (it used to send `[continuing]`).

- docs: documentation brought in line with what the host does today. The
  README opens with what it is used for (long-lived residents, continued
  conversations, fleets, knowledge mining) and its reference sections were
  corrected against the code — MCP servers are recipe opt-in, `"webui": true`
  alone refuses to start off loopback, no Rust toolchain is needed, and the
  full provider, environment-variable, slash-command, key-binding and recipe
  tables. `ARCHITECTURE.md` is rewritten as-built. The original architecture
  document and the headless-fleet, unified-tree and locus-routing plans move
  verbatim to [`docs/history/`](docs/history/README.md), with notes on what
  became of each; the living headless/fleet protocol they contained is now
  [`docs/fleet-protocol.md`](docs/fleet-protocol.md). New
  [`docs/README.md`](docs/README.md) indexes every guide. Drift fixed across
  the memory and gating guides (adaptive resolution, L1…L8, what the
  compression pass actually sees, `gate_status`, `wake_add_rule`), the
  deployment, dev-environment, WebUI and debug-API guides, and the recipe
  setup guides (the TUI's chat ↔ fleet views, the `[y/N/d]` quit prompt).
  Source comments and the no-subfleets error now point at the new locations.

- docs: new [`docs/claude-code-ingest.md`](docs/claude-code-ingest.md) — continuing a
  Claude Code session transcript as a resident (active-branch walk, verbatim signed
  thinking, `tool_result` storage shape, verify-on-a-copy, and a `reasoning_extraction`
  refusal triage + mitigation section). `AGENT-ONBOARDING.md`: recipe skeleton updated to
  the tuned production values (300k/100k/32k, chunk 3000, merge 6, recall 40k, tool-prose
  fallback, `refusalHandling`), new §5b on `kv-stable` vs `kv-unified` with the reference
  kv-unified configuration and its preconditions, and new gotchas §11.8 (topology audit /
  open-mutates-store), §11.9 (`reasoning_extraction`), §11.10 (model-bound signed thinking).

- README documents `enabledFeatureSets` (omitted = every declared set; `[]` in
  a recipe or `mcpl-servers.json` = none, while the agent's overlay file reads
  `[]` as unset; a set without valid `uses` stays disabled) and model-facing
  MCPL tool names (`mcpl--<serverId>--<tool>`). The `toolClassOverrides`
  examples now use that form; `cua--*` and `blender--*` matched nothing.
- The shipped `knowledge-miner.json` and `clerk.json` prompts, and the setup
  guides, name the MCPL tools as the model sees them (`mcpl--zulip--listen`,
  `mcpl--gitlab--get_issue`, `mcpl--ddg--search`, `mcpl--syncntn--*`,
  `mcpl--scribe--*`) rather than without the `mcpl--` prefix.
- `mcpl_deploy`'s description and the overlay comments no longer call
  `disabledFeatureSets: ["*"]` deny-all: in feature-set patterns `*` matches
  exactly one dot-separated segment, so denying every set takes a pattern per
  depth (`["*", "*.*", "*.*.*"]`). `disabledTools: ["*"]` is deny-all for
  tools, as before.

### Fixed

- Fleet state snapshots no longer persist resolved child environment overrides. Adopted children recover restart overrides from the current matching recipe configuration, including `autoStart: false` entries; legacy persisted env is ignored. A child with no matching configured name, recipe, and data directory gets no overrides. A same-name recipe or data-directory mismatch logs the mismatched fields and withheld restart overrides without logging their values. Existing Chronicle history and backups may still contain previously saved secrets; operators should rotate affected credentials and handle historical copies according to their retention policy. Running child processes keep their existing environment until restarted.
- Evacuator-generated recipes pin the imported participant before host construction, keeping the live framework and Membrane role anchor aligned through `/session switch`. Name resolution uses `--agent`, then the chosen warmup session's sidecar, then `Claude`; the same name is passed explicitly to warmup. For custom imports without a selected warmup session or sidecar, supply `--agent`. Existing generated recipes need their hardcoded `agent` name corrected. Warmup selection rejects duplicate titles and ambiguous ID prefixes with candidate IDs; the guide and CLI explicitly require selecting the intended imported store before chatting under the revival identity. Replacing an output recipe with a different participant emits a warning, including when a resumed run falls back from a custom name to `Claude`.
- Headless command replies bypass event subscriptions like other protocol responses. Fleet commands and direct socket clients receive `command-output` even with narrow or empty subscriptions; unrelated telemetry remains filtered. Protocol replies stay with the requesting connection and are discarded if that connection closes or is replaced while work is pending. The headless log reports the dropped response type and reason, without its payload.
- The WebUI and fleet WebUI smoke-test recipes bind to `127.0.0.1`, so their unauthenticated local servers pass the existing bind-safety check. The fleet parent uses port 8788 and its child uses 8787 to avoid competing for one listener.
- The clerk recipe's channel-management procedures use `wake_add_rule` and `wake_remove_rule` for live, persisted gate changes, while retaining Zulip subscriptions and protected default policies. They no longer direct the clerk to edit a Chronicle workspace copy or promise a timed reload. The prompt distinguishes recipe-shipped rules restored at startup from runtime-only rules whose removal survives restart.
- The generic provider logging wrapper forwards an adapter's optional `toolResultImageMediaTypes` capability, preserving its native tool-image policy. Older adapters keep their existing behavior; Gemini HEIC/HEIF history preservation requires a membrane version containing antra-tess/membrane#92.

- **`GATE_TELEMETRY` now parses fail-closed** (#119). The env-flag parser
  treated every non-empty string except `0`/`false` as ON, so `off`, `no` and
  ordinary typos ENABLED the telemetry headers — with a configured base URL,
  the exact data-boundary leak the double gate exists to close. Only an
  allowlisted affirmative (`1` or `true`, trimmed, case-insensitive) enables
  it now; recognized negatives stay silent and any other value warns once,
  naming the accepted forms. The same fail-open parser copy guarding
  `LLM_CALLS_FULL_PAYLOADS` in the llm-calls logger is hardened identically.

- Recipes warn about keys the host never reads, at the top level, under
  `agent` and under `modules`, naming what each was probably meant to be
  (`mcplServers` → `mcpServers`; `modules.files` was replaced by
  `modules.workspace`) (#167). A warning, not an error, so recipes carrying
  leftovers keep loading. The known-key lists are type-checked against the
  `Recipe`, `RecipeAgent` and `RecipeModules` interfaces, so a key added to
  one can't be forgotten in the other.
- Shipped recipes lose their dead keys: `claude-export-revive.json`'s
  `mcplServers` (now `mcpServers`), `mcpl-editor-test.json`'s `modules.files`
  (now `workspace: false`) and its hybrid Sonnet model id (now
  `claude-sonnet-4-6`); `knowledge-miner.json`'s description no longer
  advertises the Notion and audio/video sources 0.8.0 removed (#167).

- With reasoning enabled, requests to models that do not support adaptive
  thinking (Haiku 4.5, Sonnet 4.5, Opus 4.5 and older) no longer carry
  `thinking: { type: 'adaptive' }` and 400. The setting is host-wide, so
  RetrievalModule's default Haiku calls were failing on every compile.
  Those models are logged once and sent without `thinking`.

- Per-agent token counts now count each provider call once. agent-framework's
  `inference:usage` sample is the stream's running total (membrane sums every
  call so far), and `inference:completed` carries the total again, but the
  agent tree added every sample and the completion. So a multi-call stream's
  earlier calls were counted again with each later sample and once more at
  completion. This affected the Web UI sidebar's `out` badges, the parent's
  included, since it sums its agents, and the Usage panel's per-agent and
  breakdown rows. The session totals (the TUI's `Σ` and the Usage panel's
  parent row) and the call ledger don't come from these samples, so they don't
  change.
- Context-size readouts show the latest call's prompt: its fresh input plus
  its cache reads and writes. That sum holds for a provider adapter that
  declares its cache convention; membrane passes an `unknown` adapter's
  counts through as they come, and where that input already includes the
  cached span (Gemini's very likely does), a cache hit reads high. They had
  shown the stream's summed fresh input, which is neither one call's prompt
  nor the context size. This covers the TUI's `ctx:N/budget` gauge and
  per-agent `…ctx`, the Web UI sidebar's `…cx`, a finished subagent's context
  size, and an agent's `input` in the Usage panel. That `input` is the
  agent's own context, plus its subagents' for an agent that has them, since
  the panel sums a subtree. While a call streams, a local agent's `…ctx` in
  the TUI still adds an estimate of the output streamed so far.

- Batch mode (stdin not a TTY, no `--headless`) now says what it is doing: a
  `[batch]` line at the start says the run ends when stdin closes and names
  `--headless` as the way to keep serving, and a line before the teardown
  names the MCPL servers it closes. Each server's `mcpl-stderr` log gets a
  `[host] closing: batch run complete` line ahead of its `connection closed`.
  When the web UI is on, a last line says it stays up with the agent stopped.
- Batch runs exit as soon as they finish. The 120 s cap on waiting for each
  reply was never cleared, so the process lingered for two minutes after
  `Done.`.

- llm-calls records from the Anthropic and Bedrock paths bound a failed call's error text as the generic logging wrapper's records do, so a provider error that echoes the whole rejected request no longer writes it into the record a second time beside the raw request. The `error` object keeps its shape: `name`, cut at 128 characters; `message`, cut at 4,000 to its head and tail around a marker stating the omission; and on the Anthropic path `stack`, whose header names the message above instead of repeating it when that header is the error's own "Name: message" line, and which is cut at 4,000 as well. `errorChars` gives the whole message's length when it was cut. For an `Error` carrying them, the provider's classification (`errorType`, `httpStatus`, `providerErrorCode`, `retryable`) sits beside it. On the Anthropic path the call ledger's ERROR cause, live and restored after a restart, reads this same bounded message, and a failure whose message is empty is an ERROR too, where the ledger used to price it as a success. The ledger's live row also takes its model, message count and cache summary from the record's request summary, which a row restored after a restart reads too.
- Logging on these two paths no longer changes what a call returns or throws. It runs after the provider call, outside its try, and neither reading a hostile error nor summarizing the request can throw into it. As before, the Anthropic writer's capture hook keeps an error thrown by a caller's own `onRequest` hook from failing the call. On the Anthropic path the request summary leaves out only a part it can't read. A record that can't be built even so gets a minimal record (`summaryUnavailable: true`) with its kind and timing, and for a failure its bounded error, so the call still has a record: on the Anthropic path that's a call whose response can't be read, and on the Bedrock path one whose request or response can't be summarized. A rejection with `undefined` is recorded as the failure it is, and on the Anthropic path it reaches the credential monitor and the call ledger as one.

- The web console's context curve panel now compiles the resident's context as a dry run. The compile is only displayed, never sent, so its select no longer commits fold resolutions or queues compression from the plan each time the panel renders, mid-stream included. Once context-manager's thinking binding is released, a committed compile that's never sent would also fence the replies the resident is streaming, and a dry run won't. With context-manager 0.13, a dry compile still records the adaptive estimate, arms calibration and overwrites the render stats until the next real compile; context-manager #161 removes these. Like any hold query, it releases a compression hold whose deadline has passed, never one that hasn't.
- When the context's plan is over budget at the plan check, the curve now plots it and says it's over budget, with the verdict the settings panel's feasibility preview reports: whether the plan fits, and whether the next real compile would refuse it. During a paced budget descent the curve and its verdict are at the descent's target, and the page says so rather than predicting the next compile. It used to fail to load. A budget too small for the head and tail reservations, or a plan the emission check finds over, still fails the panel, as before.
- `FrontdeskStrategy` passes its select options through to the autobiographical select, so a dry run (a preview, the context curve) is no longer run as a committing one for frontdesk agents.

- The context curve page gives a summary's first and last dates by time. It used to order them by their text, weekday first, so a summary of a Wednesday's and a Friday's messages showed the Friday as its first date.

- `llm-calls` error records from the generic logging wrapper bound their error text to 4,000 characters. That wrapper serves the `openai-responses`, `openai-compatible`, `openai-codex`, `openrouter` and `mock` providers; `anthropic` and `bedrock` log through their own classes, whose records are bounded by a separate entry. The text is cut to its head and tail around a marker stating how many of how many characters were omitted, and no surrogate pair of well-formed text is split. A provider can echo the whole rejected request in its error body (one OpenAI-compatible 400 echoed ~1.7 MB), and the record already keeps that request as `rawRequest`, except when the record is over the 16 MiB size guard, which drops the raw bodies and keeps the bounded text. When the error is an `Error` carrying them, a record now also carries `errorType`, `httpStatus`, `providerErrorCode` and `retryable`, plus `errorChars` when the text was cut; `errorType` and `providerErrorCode` are cut the same way at 128 characters. A small error's text is recorded byte for byte as before.
- An error whose fields cannot be read (a throwing getter) no longer makes the wrapper throw the getter's error in place of the provider's. Each field is read on its own: an unreadable `message` is recorded as `[message could not be read]` after the error's name, keeping the classification; an unreadable or wrongly typed classification field is left out, keeping the text; and a value that cannot be read at all, such as a revoked Proxy, is recorded as `[error could not be read]`. The original error is always rethrown.
- Logging no longer changes what a successful call returns. A record that couldn't be built used to replace the provider's response with the logging error, and to be written as an error. Now a call whose request or response can't be summarized gets a minimal record (`summaryUnavailable: true`) with its provider, kind and timing, and for a failure its bounded error, so no call goes unrecorded. A null block or tool is summarized rather than thrown on. A rejection with `undefined` is recorded as an error, not as a successful call, and a record whose raw bodies can't be serialized (a cycle, a BigInt) is written without them, as for the size guard.

- `postinstall` now reports a failed optional Web UI build. It used to end with `|| true`, so when `npm --prefix web install` or `run build` failed, the install succeeded and the host added nothing to npm's own output: no summary of the failure and no retry command. The install still succeeds (exit 0), but the script now reports the failure on stderr, naming the retry command (`npm run build:web`). It does not claim what the Web UI will do: a bundle from an earlier build may still be in place, so whether one is missing is reported at start. Without a `web/` directory it stays silent, and a working build prints nothing extra.
- The host also says once at start, on stderr, when an enabled Web UI finds no bundle at its resolved path. That covers a build that was skipped rather than failed (for example `--ignore-scripts`). The page keeps its 503 and its remedy.

- Fleet preserves unresolved launch artifacts and recovers matching tracked children only after confirmed PID death, bounded regular PID metadata, and an absent or refusing Unix socket with artifact identity rechecks. Fresh parents without a record still refuse cleanup. Adopted restart records confirmed death without inventing an exit code, honors SIGKILL wait failure, and failed adoption can be retried on boot, launch, or restart. Refusals name artifact paths and existing recovery operations. Confirmed terminal records are never adopted solely because their old PID is live again. These checks do not provide cross-process locking.
- Stale Unix socket probes use the existing Node.js prerequisite to retain native errors; Bun versions that normalize resource errors cannot authorize cleanup. Missing Node, timeout, and spawn errors preserve artifacts.

- Fleet manual restarts preserve environment overrides, autoRestart, and subscriptions. Failed socket setup, subscription, or readiness now terminates the owned child before returning failure; unconfirmed termination stays blocked and is reported explicitly. The record's `exitReason` keeps the launch failure beside the exit, whichever came first.
- Fleet automatic replacements retain crash history, advance the existing backoff, and stop after three retries within 60 seconds, where a crash-looping child used to be replaced forever. `fleet--status` shows the stop as `autoRestartStopped`. A manual restart, or a launch of the same name, resets that retry budget, and kill, restart, launch or shutdown cancels a pending automatic replacement; a manual restart or launch also cancels one under way that hasn't spawned, and one refused later leaves the child down, which `autoRestartStopped` says. A signal exit, including a start the parent has to stop, isn't retried, as before, and `autoRestartStopped` now says so, as it does for a kill; a replacement that exits non-zero on its own is retried up to the cap.
- Fleet launches, manual and automatic, are refused without spawning when the parent is shutting down, or when, during their awaits, it begins to, a kill is acknowledged on the generation they replace (a restart counts from its own start), or another launch replaces it. The refusal names which. A launch adopting a living child that is interrupted stops that child instead of leaving it unowned, unless the parent is detaching, and a second launch of the name is refused meanwhile. A detaching shutdown no longer kills a child that is still starting.
- Fleet restarts also work for adopted children after confirmed shutdown. Startup tolerates transient stale-socket refusals while the replacement binds, and reports a child that exits after a refused connect with that refusal. A natural nonzero exit racing failed-launch cleanup retains its automatic retry.

- A headless child stops treating a client as current once its socket ends or
  closes, including a reset with no `end`, such as a parent that died with
  events still unread, and writes no telemetry to a socket that has ended or
  errored. Commands the child reads from a client after a newer client has
  replaced it are dropped: the first is logged, and the client's disconnect
  line counts them. A command admitted while its client was current still
  finishes, with its answers dropped. Both mattered on runtimes with Node's
  socket semantics, such as Bun 1.4.2. There a reset socket stayed current,
  so telemetry kept going to it until the next client connected, and only a
  socket error was logged, never the disconnect. A superseded client's
  `subscribe` replaced the new client's filter, its `text` reached the agent,
  whose output then went to the new client, and its other commands ran, with
  the answers `reply()` sends dropped. Bun 1.3.14 gives a reset socket an
  `end` and closes a superseded socket whole, so neither happened there.
- A fleet parent lets go of a child's socket at its `close` as well as its
  `end`. After a reset with no `end` (on Bun 1.4.2, a child that died with
  the parent's commands unread), the fleet's requests to that child, such as
  `requestDescribe`, report it unreachable instead of writing into the dead
  socket. A spawned child's exit already let go of it; an adopted child has
  no exit event to.

- `identity--request` sends `PATCH`. Its method list, in both the advertised schema and the handler's check, stopped at GET/POST/PUT/DELETE, so a resident's PATCH was refused before it reached the service, and PATCH-only routes such as orrery's node update (starring, archiving, a curator's note) were out of reach. A PATCH carries a JSON `body` or a `fromFile` upload exactly as POST and PUT do. The service allowlist with host-attached access stays the boundary, and each service still authorizes the request.
- `identity--request` refuses a `body` or a `fromFile` with GET, naming the methods that send one. `method` defaults to GET, so a write that left out its method used to be sent as a read, its body dropped, while the call reported success.
- `identity--request` reports an empty response, such as a 204, as `{ status, body: "" }`. It used to describe it as an omitted binary response and advise repeating the request with `saveAs`, which for a write would send it again.

- Makeup panel: an anthropic-xml agent's exact `count_tokens` figure includes the agent's `prefillUserMessage` where inference sends it: first, in place of the formatter's default opener, whenever the request would otherwise open with the assistant's turn, as a prefill transcript usually does. The count used to carry that default instead (`[Start]`, or for an agent with no system prompt, the CLI-simulation system block and its `<cmd>` pair).

- Makeup panel: the exact `count_tokens` figure now counts the request the agent's own formatter would send — built through `buildMessages` (participant prefixes where the formatter places them, tool-pair normalization, same-role merging, native tools) so every block the formatter sends counts, which for the native formatter includes signed `thinking` / `redacted_thinking`, `tool_use`, `tool_result` and images — instead of a text-only flattening that omitted most of a keep-all model's prompt (read up to ~10× below billed). The response also carries `lastBilledInputTokens`: the provider's fresh + cache-read + cache-creation total of the agent's last call, a free exact reading that needs no request.

- A server deployed with `mcpl_deploy` now gets the environment every boot-loaded server gets. That includes the refusal-reaction baseline, `DISCORD_SUPPRESSED_REACTIONS_BASELINE`, as a default its own env can override, which a deployed Discord adapter used to start without.
- `mcpl_deploy` judges each field as given, and refuses a wrong kind with nothing saved, where it used to drop or coerce it: an `env` given as text, a number or true/false, `args` that weren't a list, a `toolPrefix`, `token` or `access` that wasn't text, a `reconnect` that wasn't true or false, or a tool or feature-set list given as text all vanished, and a `null` arg was saved as `"null"`. A field left out, `null`, `""` (or only spaces) for text, or `[]` for a list is unspecified, as strict function calling sends it, so an empty or blank `toolPrefix` is no longer saved for the framework to keep in place of its default prefix. A tool or feature-set list holding an empty name, an allow-list that matches nothing, is refused. Numbers and true/false in a list are saved as their text. The id `__proto__` is refused: JavaScript reads it as an object's prototype, so its entry was never saved, though the deploy said it was.
- Saving `mcpl-servers.json` or `mcpl-servers.agent.json` keeps the root's keys besides `mcplServers`, such as an entry under a misspelled key, which every save used to drop, and never overwrites a file that doesn't parse.
- `mcpl_unload` reads the overlay before it disconnects, so a file the boot would stop on refuses the unload with the server still loaded. It disconnects only a server that's listed. An id the overlay alone names has its entry removed, or its tombstone kept, and an operator's server that isn't loaded is tombstoned, each with a receipt saying it wasn't loaded in this session. A disconnect that fails leaves the overlay as it was, and says so. If the overlay can't be read or saved after a disconnect that succeeded, the receipt says the server is gone and nothing was recorded, and unloading it again records it. Deploys, restarts and unloads of one server run one at a time, in the order they're called, so a deploy made while an unload disconnects runs after it and keeps its entry. A session-only unload says what the next host start loads, read from the overlay: a tombstone, the agent's entry, the operator's definition, or nothing. A tombstone for an id the operator defines says how that definition comes back.
- `mcpl_list` no longer labels a recipe server named like an inherited key, such as `constructor`, as a file server.

- `mcpl_deploy` refuses a server that would send a credential over unencrypted `ws://` to a host other than this machine, where anyone on the network between could read it. It recognizes four carriers: the `token` field, the credential an `access` grant attaches, a user or password in the url, and a `token` parameter in the url, the one agent-framework's transport sends. No other query parameter is recognized. A blank token is no credential, but a grant counts whatever its name. The refusal says to use `wss://`, or, if that network is private, to ask the operator to add the server to the recipe, and it says when a server already configured under that id is left as it was. A recipe server like that, or an overlay entry deployed before this change, still loads, with a warning at startup; there a grant counts only when the recipe's identity attaches its credential. This machine is `localhost`, 127.0.0.0/8, `::1`, IPv4-mapped 127.0.0.0/8 addresses, and `0.0.0.0`, `::` and `::ffff:0.0.0.0`. Any other name, `localhost.` and names under `.localhost` included, counts as another machine, since a resolver may not answer it with this one. The tool's `url`, `token` and `access` descriptions say what it takes over `ws://`.

- `mcpl_restart` keeps its overlay note when the restart throws, and an `mcpl-servers.agent.json` that can't be read no longer turns a successful restart into "mcpl_restart failed": the receipt reports the restart, says the file couldn't be read as an overlay and that the next host start will stop on it until it's fixed, and doesn't quote it. When the live server's overlay entry is one the boot skips, the restart's note says so and what the next start loads. For a tombstoned id, it says the overlay keeps the server unloaded and how to bring it back: for an id the operator defines, that's removing the tombstone from the file, since `mcpl_deploy` would load the agent's own entry instead. The overlay-replacement receipts no longer report `AGENT_TIMEZONE`, which the host sets over every server's mapping, as lacking, and they do report a replacement that names a different `access` grant as lacking the operator's, comparing each grant as it's dialled, as written. A token counts as present on either side whenever agent-framework would send it.
- `mcpl-servers.agent.json` entries are read the same way by the boot, the startup warnings, `mcpl_list`, `mcpl_restart` and `mcpl_unload`. The boot passes each entry to agent-framework as it did before, except where the old handling broke, and the startup log names each such place: `args` holding numbers or true/false read as their text, where the start used to stop; a tool or feature-set list given as one name reads as a list of one, where it used to be read character by character, so a one-name deny list denied nothing; a capability list given as one name, which used to be ignored, does too; a `toolPrefix` that's a number or true/false reads as its text, and one that's an object or a list as absent, so calls to the server's tools reach it; and a capability that can't be read as text denies nothing, where the start used to stop. The log also names a `transport` other than `stdio` or `websocket`, which agent-framework ignores, and an entry its transport can't open, a websocket one with no `url` or a stdio one with no `command`, which still replaces any operator definition, as before.
- `disabled: true` tombstones a server whatever else its entry holds; the agent's unload wins. The boot skips an entry that isn't an object, has `args` that aren't a list of text, numbers or true/false, names neither a `command` nor a `url`, or has a `disabled` that's truthy but not `true`. It logs why, and loads the operator's definition, if any. Two of these used to stop the host from starting: a `null` entry, and `args` that aren't a list of text. The others were skipped without a word. `mcpl_list` names a skipped entry as malformed, and no receipt counts it as replacing anything. For an id the operator defines, the advice says that `mcpl_unload` tombstones the operator's server, which the boot loaded in the entry's place. `mcpl_list` no longer calls a server unloaded while it's still connected under a tombstone written since it started.
- `mcpl_deploy` refuses an `env` that isn't a map of text, numbers or true/false, saving nothing, where a `null` env value used to be saved before the deploy threw. An empty list as `env`, which strict function calling sends for "unspecified", deploys with no env.
- A file that isn't valid JSON, or whose root is `null`, still stops the start, now with an error naming the file and advising a fix: moving it aside would load every server the agent unloaded. Every other root and `mcplServers` starts the host as before. A root that isn't an object, or an `mcplServers` that's text, a number or true/false, loads nothing, and an `mcplServers` that's a list holds its items as entries named by position; the startup log names each. It also names keys besides `mcplServers`, since a misspelled key would drop the agent's tombstones. `mcpl_unload` reads the file again after its disconnect, so an entry another call wrote meanwhile for another id isn't lost, and an inherited name such as `constructor` is no longer taken for an entry.
- A replacement whose `access` names a host variable is named, as one whose `token` does. `mcpl_restart`'s note on a replacing entry says that it describes the file as it is now, since the restart reconnects with the configuration of the server's last connect: a hand edit made since then takes effect at the next host start, unless a later `mcpl_deploy` replaces it. The receipts read an entry by the connection agent-framework opens for it, which an explicit `transport` decides. `mcpl_list`'s source label reads the overlay file as it is now, and its target label is a server's command, else its url, as before, since agent-framework's status doesn't say which of the two it opened.

- **`mcpl_restart` and `mcpl_deploy` no longer report a server as working when it isn't, and the MCPL admin receipts say what an agent-overlay entry doesn't carry.**
  - Both now fail when the server isn't connected afterwards. Before, a restart reported success while its own text read "NOT connected", and a deploy said "connected" without checking. A WebSocket server whose first dial fails comes back as a stub that keeps retrying, without the call throwing, so either could happen.
  - An agent-overlay entry under the id of a recipe or `mcpl-servers.json` server replaces that definition whole: its text is literal, and it never inherits the host environment. So the operator's value for anything the entry doesn't declare never reaches the server. A stdio child gets the entry's own env, plus the host's values for a short allowlist such as `PATH` and `HOME`. A server that needs the operator's value can look healthy until its first call. `mcpl_deploy`, `mcpl_restart` and `mcpl_list` now say when a server runs such a replacement, and name what it lacks: env names (never values), a token, an `access` grant, or `inheritEnv`. `mcpl_unload` of a replacement says the operator's definition loads again at the next start.
  - A `${VAR}` reference in an overlay entry reaches the server as literal text, since only a recipe substitutes it. `mcpl_deploy` and `mcpl_restart` now say which parts of an entry name a host variable, and a replacement's env value that names one counts as lacking.
  - The host logs both at startup.

- Operator ledger: price `claude-opus-5`, which matched no prefix in the rate
  table and so showed no cost at all — every call on it, including subagents
  spawned at the Opus-tier default, priced as nothing.
- Operator ledger: charge Claude Fable 5.1 and Claude Mythos 5.1 cache reads
  at 0.025x base input ($0.25/MTok) instead of the 0.1x every other model uses. A long-lived agent
  that re-reads a large cached prefix on every call spends most of its bill on
  cache reads, so the flat multiplier overstated its total several-fold. Cache
  reads on all other models, and input, output, and cache writes on the 5.1
  pair, are unchanged.
- Operator ledger: price Claude Sonnet 5 at $2/$10 for every call. The table
  still switched it to $3/$15 on 2026-09-01, but that scheduled increase was
  withdrawn and the introductory rate became the standard one, so every
  Sonnet 5 call since September 1 was overstated by half.
- `ANTHROPIC_PRICING_VERSION` moves to `anthropic-public-2026-09-21`, so
  replayed JSONL is re-priced under a version string that says which table
  produced it.

- A saved reasoning setting the API would reject (for example `effort: "minimal"` or an unknown `display`) no longer fails every turn: invalid values fall back to their defaults when settings are restored, with a log line, and the adapter never sends an effort level outside the known set.

- WebUI: the rollback / suppress row actions now sit inside the message row
  (top-right, labelled) instead of hanging off its left edge, where the
  scroll pane's overflow clipping made them nearly invisible; the Context
  document's "roll back to here" is faintly visible before hover. The static
  server now sends `Cache-Control: no-cache` for `index.html` and
  `immutable` for hashed `assets/`, so a stale tab can no longer pin an old
  index/bundle pair across a bundle swap.
- **Recipe authors using `kv-unified`:** `agent.strategy.kvUnified.preserveGapBearingSummaries` must now be an explicit boolean, and cannot be `true` together with `treeifyNonContiguousSummaries`. Add the flag to older recipes. Both requirements already apply in context-manager; invalid configurations now fail at recipe load instead of the first solve. Valid explicit policies and other folding strategies are unchanged.
- MCPL server definitions in `mcpl-servers.json` now preserve `inheritEnv`, and recipes can override it (including explicit `false`) for file-defined servers. Recipes and server files reject non-boolean values. Agent-owned overlays strip `inheritEnv` entirely, including when replacing an operator-defined server; full host-environment access is an operator grant. Full environment inheritance requires an agent-framework version containing its PR #175; the host's locked 0.19.0 predates that control and remains unchanged.

## 0.9.0 — 2026-09-21

### Added

- Recipes can set **`modules.history: true`** to attach agent-framework's
  `HistoryModule` (agent-framework 0.16.0): `history--stats` / `history--extract`
  / `history--search` / `history--overview` tools for querying an agent's own
  uncompressed chronicle via native secondary indexes, and for browsing
  already-compressed spans via existing compression summaries (no new LLM
  calls). `bind()` is wired post-creation with the agent's live
  `ContextManager` and the framework's `ChannelRegistry` (when MCPL is
  configured), so channel-filter arguments on all four tools accept a live or
  historical channel label/address, not just the raw internal channel id.
  Bumps `@animalabs/agent-framework` to `^0.16.0` and
  `@animalabs/context-manager` to `^0.10.0` (both required for `HistoryModule`
  and its summary-overview support) and `@animalabs/chronicle` to `^0.4.0`
  (native secondary-index support the history tools depend on).

- Recipes can set **`agent.retry`** (Membrane's retry policy, passed through
  verbatim) and **`mcpServers.<id>.requestTimeoutMs`** (the framework's
  per-server JSON-RPC timeout). Both knobs existed underneath — Membrane's
  `MembraneConfig.retry` and `McplServerConfig.requestTimeoutMs` — but the host
  never surfaced them, so a gateway 502 killed a turn on first failure
  (Membrane retries generic retryable errors zero times by default; only
  `529`/`overloaded_error` has a dedicated schedule) and a tool slower than the
  60s default (image generation) could only ever time out. Both validate at
  recipe-load time.

- Subscription hosts (Claude OAuth token via `ANTHROPIC_AUTH_TOKEN`, Codex
  login via `openai-codex`) show quota windows instead of a dollar estimate:
  the TUI status line and the WebUI header read `10% weekly | 99% 5h`, one
  entry per window the provider reports (5-hour, weekly, per-model weekly),
  and the WebUI usage panel lists each window with its reset time.
  List-price dollars were fiction on a subscription. Pay-per-token hosts are
  unchanged.
  - The windows are polled out-of-band (no inference spend) by a new
    `QuotaMeter`: the TUI polls while it runs, the WebUI only while its tab
    is visible and focused (`GET /quota`, panel op `quota`, observer scope
    `health`), floored at one provider read per 30s however many viewers.
  - A 429 while a window is spent is now recognised as a quota, not a
    throttle: the agent parks until the window resets instead of retrying
    into it and recording a failed turn per attempt. Needs an
    agent-framework with `providerHold`; on older frameworks the option is
    inert and behaviour is as before.
  - Both provider surfaces are private to the vendors' own CLIs and may
    change; an unreadable answer shows no readout rather than a guess.

- WebUI live surgery, quiesce toggle, inline images, operator log
  (requires agent-framework with `rollbackToMessage`/`suppressMessages`;
  quiesce needs agent-framework #122 — every affordance is feature-detected
  from `welcome.features`, so the bundle is safe against older hosts):
  - **Roll back to a message** (hover ⏪ in Chat, "roll back to here" on raw
    boxes in the Context document): forks at that message and makes the fork
    the live branch; confirm dialog names what leaves the context.
  - **Suppress messages** (hover ⊘ enters multi-select, floating bar to
    confirm): fork at head, redact on the fork, switch. Parent keeps them.
  - **Quiesce/resume** header switch showing the host's serving state; a
    busy-agent refusal offers "quiesce, then retry".
  - **Images render** in Chat and Context views with a lightbox. Chat frames
    carry a `ref` and the browser fetches bytes lazily from
    `GET /media/<messageId>/<blockPath>` (observer scope `messages`,
    `?scope=` proxies to fleet children) — base64 never rides the WebSocket.
    Tool-result images (read_image, cameras) render too.
  - **Operator log** in the branch panel: the host's durable
    `operator-actions.jsonl`, live-refreshed on `operator:action` traces.
  - New WS frames: `rollback`, `suppress`, `host-quiesce`, `host-resume`,
    `request-host-mode`, `request-operator-log` → `surgery-result`,
    `host-mode`, `operator-log`; `welcome.features` + `welcome.hostMode`.
    Panel op `media`.

### Changed

- Depends on `@animalabs/agent-framework` ^0.17.0, `@animalabs/context-manager`
  ^0.10.1 and `@animalabs/membrane` ^0.5.86. With AF 0.17 the quota meter's
  `providerHold` is live: a subscription 429 on a spent quota window parks the
  agent until the window resets instead of retrying into it (older AF ignored
  the option). CM 0.10.1 carries the kv-unified stale-receipt fix (CM #97);
  membrane 0.5.86 makes the ChatGPT-subscription prompt cache hit (stable
  `session_id` header). `package-lock.json` had drifted to AF 0.13 / CM 0.8 /
  chronicle 0.3 and is regenerated alongside `bun.lock`.

- The `frontdesk` strategy no longer adds its provenance header to a message
  whose server already rendered who, where, when and the id into the body
  (metadata `attributed: true`, as zulip-mcp now stamps); its question and
  mention salience scans the body with the server's `attributionHeader`
  prefix removed. Unstamped MCPL messages keep the header. Without this, a
  frontdesk agent on a current zulip-mcp reads two headers per message.

- Route ChatGPT subscription inference through Membrane's shared Responses adapter, preserving Codex app-server login, token refresh, endpoint configuration, and Fast mode controls in the host. Provider usage now declares the cache-inclusive convention and is normalized by Membrane.
- Preserve cache-usage and formatter capabilities through the logging decorator, fixing duplicate cached-input accounting for both subscription and API-key Responses calls. Keep participant names in auxiliary calls and mark logged usage with its convention while retaining the `openai-codex` provider label.
- Serialize a forced Codex token refresh behind any in-flight non-refresh acquisition, coalescing concurrent refresh callers without reusing a stale token.

- README documents `agent.proseRouting` (`locus` / `hybrid` / `explicit` /
  `disabled`) and `agent.sameRoundThinkTextPolicy`, and recommends
  `proseRouting: "disabled"` for tool-heavy agents woken from shared channels,
  where stray same-round narration otherwise auto-publishes to the sticky
  channel (#128).

### Fixed

- Subscription quota meter, review follow-up:
  - the meter no longer stops polling after consecutive failed reads (a
    timer tick suppressed by the error backoff left no timer armed — two
    failures froze the TUI readout for the life of the process);
  - the WebUI keeps asking after a transient `/quota` failure (401 before
    the observer session exists, 503 while the host binds, 5xx); only a
    definite answer ends the polling;
  - "inference parked" is shown only when the framework reports a host
    hold; a spent window otherwise reads "quota window spent — resets …";
  - the usage panel of a fleet child reads that child's own quota
    (`/quota?scope=`), so a pay-per-token child keeps its dollars;
  - the hold uses the failing agent's own model when the framework supplies
    it; a spent window with no reset time holds one slice on a fresh
    reading; numeric `resets_at` and Codex `rateLimitsByLimitId.codex` are
    parsed; per-agent dollars are hidden and call-ledger dollars labelled
    as list-price equivalents on a subscription; a TUI session switch no
    longer brings the dollar readout back.

## 0.8.1 — 2026-09-10

### Added

- Recipe `subconscious` block (tune-out, agent-framework#77): `enabled`,
  `systemPrompt` (required — the subconscious's mode block), optional `name`,
  `model`, `allowChannelSpeech`, `reAnchorFraction`. Validated at recipe load
  (unknown fields refused by name) and passed through verbatim to
  `FrameworkConfig.subconscious`; the framework owns the defaults. Requires
  agent-framework with tune-out (#115).

- Add validated recipe plumbing for Agent Framework's default-off `agent.toolWrapperProseGuard` containment boundary.

### Changed

- Gate telemetry reads `x-gate-channel` from the turn's routing locus or,
  for gate-batched wakes that set none, from the framework's telemetry-only
  `wakeChannelId` (agent-framework ≥0.14). On residents with a subconscious
  the stamp now follows the primary (the exactly-one-agent guard had
  silenced it), and — because one provider adapter serves every agent — the
  origin trio is stamped only while the primary is the only agent with a
  turn in flight; overlap withholds rather than misattributes. Compression
  debt is read from the primary as well.

### Fixed

- Recipes' `agent.strategy.mergeMaxSourceSpanMessages` now reaches the Context
  Manager (it was accepted but never passed through, so the CM default applied
  regardless of the recipe). Also plumbs and validates the Context Manager's
  `compressionSplitFallback`, `compressionSplitPlaceholder`,
  `compressionSplitMaxCallsPerChunk` and `compressionSplitMaxCallsPer10Min`
  keys (all default off / CM defaults).

- Gate telemetry classifies EventGate-batched wakes (`gate:debounce`, source
  `gate`) as origin `event` instead of passing the raw reason through.

- Name-taking commands (`/checkpoint`, `/restore`, `/checkout`,
  `/session switch`, `/session delete`) parse the rest of the line instead of
  only the first token, so multi-word names round-trip with
  `/session rename` instead of silently truncating (`/checkpoint my test
  point` used to save a checkpoint named `my`).
- `/session delete` requires `--confirm`: the bare command echoes exactly
  which session matched (name, id, message count) before anything
  irreversible happens. `/help` documents that switch/delete accept ids.
- Head-moving commands (`/undo`, `/redo`, `/checkout`, `/restore`,
  `/branchto`, `/newtopic`) are refused while a turn is in flight — moving
  the head mid-stream committed the streaming reply onto the wrong branch,
  detached from its request (orphaned Chronicle nodes), including when the
  move came from a second client on the same session.
- `/mcp add` on an existing server preserves its env vars and `toolPrefix`
  (and reports the kept env keys); previously a command update silently
  wiped the server's env, which only surfaced when the server next started
  without its tokens.
- Checkpoints are visible: `/branches` lists them alongside branches, and
  bare `/checkpoint` lists existing checkpoints (matching bare `/restore`).
- `/budget` displays small values exactly instead of flooring to `0k`
  (`/budget 50` used to report "set to 0k" while rejecting `/budget 0`).
- `/clear` clears the WebUI transcript view (client-side, like the TUI's
  scrollback wipe) instead of appending a "(cleared)" line while clearing
  nothing; `/help` and the headless reply now say what `/clear` actually
  does — display only, history and context kept.

- The WebUI HTTP surface answers honestly: unknown `/debug/*` paths (typos,
  casing, trailing slashes) return a JSON 404 instead of the SPA shell with
  a 200; missing `/assets/*` files return 404 instead of HTML (which
  produced a blank page with a MIME error on stale bundle hashes); non-GET
  methods get 405 with an `Allow` header. SPA client-side routes still fall
  back to the shell.
- The context-makeup panel's exact token count calls `count_tokens` with the
  model the agent actually runs (provider/Bedrock prefixes normalized away)
  instead of a hardcoded id that 404'd on every install and silently nulled
  `exactTotalTokens`. `COUNT_TOKENS_MODEL` remains as an explicit override;
  non-Anthropic models report `count_tokens_unsupported_model` instead of
  counting against the wrong tokenizer.

## 0.8.0 — 2026-09-05

### Added

- Recipes accept `agent.proseRouting: "disabled"` for tool-only external publication when paired with a supporting Agent Framework release.
- **`modules.instructions`** — a shared living-instructions file (a CLAUDE.md
  analogue kept in a workspace mount) injected into every agent's context on
  every turn, ephemeral subagents included. `true` for defaults
  (`instructions/AGENTS.md`, 32 KB cap, `system` position) or
  `{ path, header, maxBytes, position }`. Reads resolve through the workspace
  mount (scoping + traversal guard apply), are bounded to `maxBytes`, reject
  symlinks leading outside the mount (realpath containment), are cached by
  `(realpath, mtime, size)`, and fail open — a missing file never blocks
  inference. Recipe validation cross-checks the path's mount prefix against
  the effective workspace mounts (explicit and implicit alike) at load time,
  requires `autoMaterialize: true` on a read-write instructions mount so
  agent curation edits actually reach the disk-side injection, and rejects
  the host-managed `_config` mount (it materializes only on branch-changing
  commands). Validation and the runtime share one mount builder
  (`src/workspace-mounts.ts`), so the two cannot drift.

- Recipes accept the default-off `agent.strategy.compressionSourceOnly` flag and pass it through to Context Manager's residence-scoped L1 compression request builder (#103).

- Gate telemetry stamps why the turn fired: `x-gate-origin` (heartbeat |
  event | mail | operator | raw reason), `x-gate-channel` and
  `x-gate-counterparty` (adapter-namespaced ids, never content or display
  names) ride the stream lane under the same `GATE_TELEMETRY=1` + base-URL
  gate as the debt stamp; background calls on the complete lane carry debt
  only (#113).

- Gate-bound Anthropic calls carry an `x-gate-debt-chunks` header with the
  live compression-debt pending-chunk count (membrane `dynamicHeaders`,
  antra-tess/membrane#65) — the gateway records it per ledger row and strips
  it before the vendor. Double-gated on `GATE_TELEMETRY=1` AND a configured
  `ANTHROPIC_BASE_URL`, so the stamp can never reach a vendor endpoint;
  unreadable state sends no header rather than a guess (#109).

- Health tab renders the per-agent compression-debt reduction (state, pending
  chunks, oldest age, merge queue) and says "not reported by this stack" when
  absent — the queue is now distinct from context composition, and the top
  line reads "inference queued" (#110).

- Add complete fail-closed recipe validation and strategy passthrough for `foldingStrategy: "kv-unified"`; partial policies, invalid occupancy bands, unsafe approximation grids, and implicit treeification are rejected at load time.

- **`agent.provider: 'openai-compatible'`** — run an agent against any
  OpenAI chat-completions endpoint (Ollama, vLLM, Together, Groq, NanoGPT,
  ...) via membrane's existing `OpenAICompatibleAdapter`, which no host ever
  wired. The recipe names the endpoint (`agent.baseUrl`, validated as an
  absolute http(s) URL at load) and the model (required — no default for an
  arbitrary endpoint); the key comes from `OPENAI_COMPATIBLE_API_KEY`
  only (no `OPENAI_API_KEY` fallback — `baseUrl` is recipe-controlled, so a
  fallback would silently send a real OpenAI credential to an arbitrary
  endpoint) and may be absent for local servers.
  `agent.baseUrl` with any other provider is rejected at load time.

- Recipes can pass the Context Manager source-only compression controls through Host/FKM, including the new default-off L1 and merge final-fallback modes, with boolean validation and cross-agent isolation.

### Added

- **`agent.cacheKeepalive` — hold an idle agent's 1h prompt cache warm.** With
  `cacheTtl: "1h"`, an idle agent's cached prefix expires after an hour and its
  next wake pays a **2x cache write** over the entire context. Reading an entry
  restarts its clock, so membrane now replays the last request with
  `max_tokens: 0` (prefill only) to refresh it at cache-**read** price (0.1x).
  On by default for the anthropic provider; `{ "enabled": false }` opts out.
  - **Cost is proportional to actual idleness, not to `maxIdleHours`.** A poke
    fires only when the entry is genuinely near expiry, so a busy agent never
    fires one — its own traffic already refreshed the TTL. Measured on mythos
    llm-calls over 36h: 563 of 637 gaps were under 5 minutes, only 5 exceeded
    1h.
  - Knobs: `maxIdleHours` (default 24, measured from the last **real** request
    so pokes cannot extend their own mandate) and `refreshAfterMinutes`
    (default 45). Recipe validation **rejects `refreshAfterMinutes >= the cache
    TTL`** — such a keepalive always fires after the entry has already expired,
    paying a full cache write on every poke while still looking like a healthy
    successful call.
  - Events land in `service-stderr.log`, warn-level for `ineffective` and
    `disabled`, so a background spender is legible without opening a billing
    dashboard.
  - Sizing, from fable-cm's 11-day log (~500k-token prefix): 49.7M tokens of
    `cache_creation` landed on turns following a >1h idle gap — ~$944 of write
    premium at fable-5 rates that this converts to ~$308 of reads.

- **`provider: "mock"` — run the whole host with zero provider spend and no
  credentials.** Wires membrane's existing `MockAdapter` (previously
  unreachable from any recipe) as a first-class provider: echoes the last
  user message by default, or returns `agent.mock.defaultResponse` with
  `agent.mock.echoMode: false` for deterministic scripted output. No API
  key is required or read. Mock calls still ride the generic logging
  decorator, so `llm-calls.*.jsonl` receipts work exactly as they do for
  real providers. `recipes/mock-test.json` is a ready-made offline smoke
  recipe (loopback webui, everything else off).

### Added

- **Hybrid prose routing.** Recipes may set `agent.proseRouting: "hybrid"`: unprefixed text keeps ordinary frozen-locus delivery, while a leading `>>>destination` publication envelope routes through Agent Framework’s existing authorized cross-surface resolver. Source text retains the envelope; recipients see only the body; success/failure returns to resident context.

- **`conversations` recipe block — per-channel conversation forks.** Maps to
  agent-framework's `ConversationRouter`: the recipe's agent becomes a dormant
  trunk template, and qualifying incoming channel messages spawn per-channel
  fork agents seeded from the trunk's current context. Recipe surface: `bind` /
  `trigger` rules per channel kind (`dm`/`groupDm`/`channel`), `idleTtlMs`
  (default 12h), `closurePrompt`, and `agentPrefix`. The host fills
  `templateAgent` from the recipe and creates a fresh stateful strategy instance
  for each fork. Absent block means no routing and no behavior change.

- **Protective reaction-suppression baseline for Discord adapters.** Stdio
  MCPL children now receive `DISCORD_SUPPRESSED_REACTIONS_BASELINE` — the
  agent-framework's exported refusal-annotation set (`REFUSAL_REACTION_BASELINE`,
  comma-joined) — so a never-configured Discord adapter defaults to
  suppressing exactly the markers this host's framework stamps, instead of
  defaulting to nothing. An operator-set value on the server entry
  supersedes the house baseline, and the adapter's own precedence (filters-file
  key including explicit `[]` → legacy operator env → baseline) governs
  enforcement; lost configuration stays stale rather than re-defaulting.
  Requires an agent-framework release carrying the `REFUSAL_REACTION_BASELINE`
  export.

- **Standing autobiographical production target.** Recipes may set `agent.strategy.productionBudgetTokens` to keep the summary forest deep enough for a later live context-budget descent without a fold storm. This is a context-token target passed through to Context Manager, not a provider-spend ceiling; omission preserves Context Manager defaults.

- **`mcpl_list` reports manifest freshness.** Each loaded server now shows the
  last validated manifest revision plus fetch and grant-negotiation timestamps.
  Older Agent Framework versions remain legible as `manifest=unknown`, and the
  server-authored revision is quoted and bounded before reaching model-facing
  text.

- **`BEDROCK_BASE_URL` env hook** for the bedrock provider — mirrors
  `ANTHROPIC_BASE_URL`, routing bedrock-runtime calls through an inference
  gateway (gate.animalabs.ai/bedrock/<credSet>). The gate reads the agent
  token from the SigV4 Credential (`AWS_ACCESS_KEY_ID` slot), discards the
  client signature, and re-signs with real AWS creds. First user: Princess,
  moved off the first-party Anthropic API (classifier "bio" false-positive
  streak) onto Bedrock Sonnet 4.5 via gate apse1 — needs membrane ≥1dcd4e3
  for `global.` inference-profile id pass-through.

### Changed

- **Dependency floor: agent-framework `^0.10.0`, chronicle `^0.3.0`,
  membrane `^0.5.78`.** af 0.10.0 brings `ConversationRouter` (the
  per-channel conversation-fork machinery this release’s `conversations`
  recipe surface targets, and includes the current `hybrid` prose router) and exports `nudgeAgent`, which `/nudge` has
  called since it landed — on every published af before 0.9.0 that call
  was a guaranteed `TypeError`, so the floor also makes `/nudge` actually
  work. Chronicle `^0.3.0` aligns the whole tree on one chronicle copy
  (previously context-manager `0.6.3` nested its own `0.3.0` next to the
  host's `0.2.x`). Operators: run a clean `npm ci` — a stale
  `node_modules` predating the lock is the known failure mode here.

- **The public triumvirate recipes boot from a fresh clone.**
  `knowledge-miner.json` no longer ships a `syncntn` (Notion) block pointing at
  an org-internal adapter that isn't publicly available — with `NOTION_*` env
  vars unset the block failed recipe load, and with them set it died at spawn
  on the dangling `../syncntn` path. The `scribe` block is dropped for the
  same reason: it hard-required `GEMINI_API_KEY` and a `../scribe-mcp`
  sibling checkout, neither mentioned anywhere in the setup guides — a
  guide-following fresh install always got a crashed miner. Notion and
  Scribe are now add-a-block opt-ins, documented in SETUP.md and
  TRIUMVIRATE-SETUP.md (the miner prompt's tool-name contracts are
  unchanged). `triumvirate.json` declares
  webui Basic-Auth defaulting to `admin`/`admin` (override via
  `WEBUI_USERNAME` / `WEBUI_PASSWORD` in `.env`) instead of bare
  `"webui": true`, which the non-loopback bind guard refuses to start.

- **agent-framework `^0.11.0`** (was `^0.10.0`). Activates `proseRouting:
  "disabled"` for recipes that set it (#100 accepted the key; the runtime now
  implements it — generated prose is never published externally, only explicit
  tools speak), plus AF 0.11's Windows workspace-mount fix and the
  org-acceleration 429 cooldown. Clears the last two standing cross-package
  `tsc` errors — the typecheck is fully clean at this lock.

- Changelog entries now land as per-change fragment files in `changelog.d/`
  (`<slug>.<breaking|added|changed|fixed>.md`), folded into the version
  section at release time — concurrent PRs no longer conflict in
  `CHANGELOG.md`. Editing `## Unreleased` directly still works and is merged
  at the same point.

- **membrane `^0.5.80`** (was `^0.5.78`, lockfile-resolved 0.5.79). Two
  latent cache behaviors the host already configures become ACTIVE with this
  relock: the prompt-cache keepalive (`agent.cacheKeepalive`, on by default —
  previously passed to an adapter version with no such field and silently
  ignored, so idle gaps over the 1h TTL repaid a full cache write on wake)
  and the floating cache marker (incremental prompt caching inside the native
  tool loop, membrane's default-on). Both reduce cost; neither changes
  visible agent behavior. Also clears two of the four standing cross-package
  `tsc` errors (the membrane-typing pair).

- Depend on `@animalabs/agent-framework` ^0.12.0 and `@animalabs/membrane` ^0.5.82 —
  the published versions that implement the active-turn trigger and the
  lane-aware `dynamicHeaders` the wake-cause stamp (#113) relies on; the
  compatibility cast and optional lookup are gone, and an adapter-level test
  proves a stream call carries the origin trio while a complete call carries
  debt only.

### Fixed

- **Prompt-cache keepalive events all go to stderr**, so every one of them lands
  in `service-stderr.log` beside `[inference-refusal]` instead of being split by
  severity across two sinks. Routine `refreshed` events previously went to
  stdout — which the host unit leaves on the journal — so the log an operator
  actually greps showed nothing. Observed on fable-cm 2026-08-23: the keepalive
  refreshed a 523,102-token prefix three times, correctly and with zero cache
  writes, while a monitor tailing `service-stderr.log` reported no activity for
  three hours. A background spender that can't be found in the operator's log is
  indistinguishable from one that never ran.

- Plumb `agent.strategy.compressionRecallBudgetTokens` through recipe validation and Framework strategy construction, with positive-integer validation instead of silently accepting an inert key.

- **Saved recipe snapshots no longer contain resolved secrets.** `loadRecipe`
  substitutes every `${VAR}` — API tokens included — and the host then wrote
  that fully resolved recipe to `$DATA_DIR/.recipe.json` at default file mode:
  plaintext credentials in the exact directory deployments bind-mount and back
  up (found by an external recipe review that verified live tokens in a backed
  up `data/` directory on a production VM). The snapshot now keeps the
  pre-substitution form — `${VAR}` references literal, a URL `systemPrompt`
  kept as the URL — and a resumed session re-runs substitution, validation,
  and the prompt fetch against the *current* environment, so secret rotation
  and remote prompt updates take effect on restart without re-cooking. The
  file is written 0600 and re-chmod'd 0600 on every save. Legacy resolved
  snapshots (no `$unresolved` marker) still load verbatim, with no
  substitution, so a literal `${...}` surviving in prose cannot fail them;
  resuming an unresolved snapshot whose required env var has since disappeared
  fails loudly naming the variable instead of silently starting the default
  recipe.

- **Ephemeral subagents inherit the caller's `proseRouting` mode.** They
  previously always ran AF's `'locus'` default regardless of the recipe, so a
  resident running `proseRouting: "disabled"` still spawned subagents whose
  between-tool-calls prose published live into its open channel as parent
  speech (field-confirmed on a deployed resident, 2026-08-26 — including
  after the recipe adopted `"disabled"`, which reached only the resident).

### Fixed

- **`mcpServers.<id>.source` accepts cook's npm registry form.**
  `validateRecipe` demanded `source.url`, but connectome-cook's source grammar
  also has `{ "npm": "pkg@version" }` — which the shipped knowledge-miner
  recipe uses for its gitlab server, so that recipe failed to load
  (`mcpServers.gitlab.source.url must be a non-empty string`). Exactly one of
  `url` / `npm` is now required; the field remains build-tooling metadata,
  ignored at runtime.

## 0.7.4 — 2026-08-03

### Changed

- **Frontdesk agents ride the adaptive path.** `frontdesk` strategies now
  default to adaptive resolution + kv-stable folding, same as
  `autobiographical` (a recipe can pin `adaptiveResolution: false` to keep the
  old hierarchical renderer). The hierarchical renderer reserves nothing for
  the raw tail and cannot shed summary mass, so a long-lived frontdesk agent
  eventually saturates its fixed context budget into a terminal
  `UncoveredDropError` refusal loop — the 2026-08-03 boter clerk outage.
  Details and deltas:
  - Topic-aware chunking now rides context-manager's `chunkBoundaryHint` seam
    (requires CM ≥0.6.3) instead of a fork of `rebuildChunks` that silently
    bypassed chunk-record persistence and the fail-closed orphan guard.
  - Existing frontdesk stores carry no chunk records (the fork never wrote
    them); context-manager's `migrateChunkRecords` backfills them from L1
    `sourceIds` on first load, so upgraded stores do not re-compress lived
    history. First boot re-plans folds (one-time KV churn, possibly a burst of
    L1 production for the un-summarized frontier).
  - The salience-biased L1 emission order is retired (it was a hierarchical-
    renderer concept); unanswered questions/@mentions are still preserved
    verbatim through the compression prompt.
  - Witnessed chunks now get the base witnessed compression prompt; the fork
    predated witnessed prompts and overrode them.

### Added

- **Every WebUI inspection panel now works per fleet child.** One persistent
  scope dropdown in the sidebar header ("inspecting: …") replaces the
  per-tab pill rows Lessons/Files carried — MCPL, Context, Settings, Pins,
  Health, and the main-pane Context document all follow it, instead of the
  previous split where only Lessons/Files could switch (statefully, via
  duplicated pickers), Context 404'd by mis-sending the child name as an
  `?agent=` param, and MCPL/Settings/Pins/Health were silently locked to the
  fleetmaster. Backed by one generic fleet IPC verb pair
  (`panel-request`/`panel-response`) dispatching into a shared panel layer
  (`src/web/panel-data.ts`) that both the WebUI host and headless children
  run — a new panel op needs no protocol change to work fleet-wide.
  Details:
  - `/debug/context/{,makeup,coverage,curve,preview,maintenance}` and
    `/healthz` accept `?scope=<child>` — the host proxies to the child over
    the fleet IPC and answers with its JSON verbatim (still curl-able;
    connectome-doctor / fleet hub can now watch children through the host).
    `/curve?scope=<child>` passes through to the scoped JSON.
  - The MCPL tab shows the scoped process's **live** loaded servers
    (connection status, tool counts — the long-missing fleet mcpl snapshot)
    above the shared registry file; registry edits stay host-scope (the
    file is one cwd-shared registry, so a "child-local edit" would be a
    lie) and the panel says so instead of hiding the fact.
  - Settings mutations, dry-run previews (single-flight guard now lives in
    the target process), and pin add/remove run inside the scoped child;
    child pins snapshots ship picker candidates (real store ids) since the
    SPA has no window into a child's message store.
  - Scoped WS responses (`lessons-list`, `workspace-*`, `mcpl-list`,
    `settings-state`, `pins-list`) now echo their `scope`, and the SPA
    drops replies that arrive after the operator switched — fixing a
    pre-existing race where a slow child's lessons/files could render under
    another child's header.
  - Child health snapshots include the child's recent provider-call ledger.
- **TUI: context budget gauge.** The status bar's `ctx:` readout and the fleet
  tree's per-agent readouts show `142k/180k` against the *live* runtime budget
  (runtime overrides win over the recipe), and the status segment goes yellow at
  75% / red at 90% — "how close to compression/trouble" at a glance instead of a
  bare number.
- **TUI: fleet view viewport.** The tree now scrolls with the cursor
  (`┈ N lines above/below ┈` markers) instead of clipping past the bottom of the
  terminal — previously a large fleet let the cursor walk below the fold and
  Del:stop targeted rows the operator couldn't see.
- **TUI: fleet view opens with a summary header** — agent counts
  (running/done/failed/cancelled across local subagents *and* fleet children),
  children up/crashed, session cost — plus the active ops alerts in full (the
  status bar only has room for a count).
- **TUI: event timestamps.** Alerts, tool batches, subagent results, wake
  triggers, branch switches, errors and user messages get an `HH:MM` prefix, so
  scrollback read an hour later still answers "when".
- **TUI: root-agent tool completions are visible.** Verbose shows every
  `✓ tool (1.2s)`; terse shows the slow ones (≥2s). Slow *running* tools show a
  live elapsed in the status bar after 5s — "still executing" and "stuck" no
  longer look identical.
- **TUI: the status bar names the worst active alert** (`⚠ 2 ·
  compression-quarantine`), with quarantine and inference-exhausted outranking
  the merely-recent.

### Changed

- **TUI: thinking honors the Ctrl+V verbose toggle.** Terse mode collapses live
  thinking to a counting one-liner (`💭 thinking… ~1.2k tok`) and replayed
  history thinking to one truncated line per block — the toggle's label always
  claimed this.
- **TUI: session-history replay caps at the last 50 messages** (marker points at
  the web UI for the rest) instead of flooding scrollback with the whole session.
- **TUI: elapsed times are humane everywhere** — `5m48s`, not `348s`; the fleet
  tree and both peek views now agree.
- **TUI: peek-proc renders child `ops:alert` events properly** (red `⚠ kind:
  message`, cyan for `-clear`) instead of a dim `· ops:alert` dot line, and no
  longer prints dot lines for per-block/per-round bookkeeping events.
- **TUI: the status-left segment truncates to fit** the terminal width instead of
  shoving the tokens/mem segment off the row.

### Fixed

- `cancel-subagent-result` was missing from the headless runtime's
  subscription-filter exemptions: a parent that narrowed the event stream
  could never see its own cancel confirmations.
- The Vite dev server proxies `/debug`, `/healthz`, `/curve`, and `/files`
  to the running host — previously every HTTP panel fetch 404'd under
  `bun run dev`.
- **TUI: "Branch switched" announcements survive.** The line was printed *before*
  `refreshFromStore()` cleared the scrollbox, so it was destroyed unread.

### Upgrade notes

- **subagents/lessons/retrieval are now opt-in** (they were opt-out, and
  DEFAULT_RECIPE enabled all three). A recipe that omits them ran them under
  v0.7.2 and stops running them on this upgrade — that is the fix for
  "lessons injected despite following the onboarding guide" (Discord issue
  #32) working as intended. A recipe that *explicitly* enables them keeps
  them, deliberately: a defaults change cannot tell old boilerplate from a
  real choice. Before upgrading an existing deployment, run

      bun scripts/audit-module-optins.ts <recipes-and-data-dirs...>

  It reports every explicit enable, every omission that changes behavior,
  and every retrieval-without-lessons combination that would go silently
  inert — and modifies nothing; the decisions stay with the operator.
  Persisted `data/.recipe.json` files are launch-time snapshots, not
  authoritative sources — the audit lists them separately as pointers back
  to the source recipe. Retrieved-lesson injection also moved from the
  system prompt to after the last user message, which keeps the stable
  prefix KV-cacheable.

### Added

- **Operator retrieval traces.** The Web UI now exposes operator-only,
  process-memory retrieval traces at `/debug/retrieval` and a readable
  lesson-selection viewer at `/debug/retrieval/view`, including invoking-agent
  attribution, mechanical candidates, relevance decisions, cache provenance,
  and the exact injected lesson block. Exact conversation/model inputs remain
  opt-in via literal `includeInputs=1`.

### Fixed

- **OpenAI retrieval reasoning effort.** Recipes using `openai-responses` or
  `openai-codex` can set `modules.retrieval.reasoningEffort` independently of
  the primary agent. Unsupported providers fail recipe validation instead of
  receiving an invalid OpenAI-shaped request, and reasoning-enabled retrieval
  requires an explicit model instead of falling through to the Claude default.
  
- **`mcpl_list` reports the live MCPL policy boundary.** Each server now shows
  connected/retrying state, whether its initial policy was established, its
  effective grant, host-masked and deny-by-default capability paths, and the
  separate host-owned `host/command` authority. During a rolling upgrade,
  fields unavailable from an older agent-framework render as `unknown` rather
  than as a misleading empty grant.

## 0.7.3 — 2026-08-01

### Changed

- **Prompt caching enabled on Bedrock for models that support it**
  (Discord issue #35). The previous transport-wide `promptCaching: false`
  was a workaround for "your request did not allow prompt caching" —
  which turned out to be the account-level denial for 3.5 Sonnet v2
  (caching there was preview-only and dropped at Bedrock's GA), not a
  transport property. Caching is now gated per model
  (`bedrockModelSupportsPromptCaching`): on for the Bedrock caching-GA
  lineup (3.5 Haiku, 3.7 Sonnet, Claude 4+), off for the pre-GA families
  (Claude v2/instant, Claude 3, 3.5 Sonnet — matched at the family
  boundary, so bare aliases and `-latest` forms gate the same as dated
  ids; non-Claude Bedrock ids are conservatively off). New recipe field
  `agent.promptCaching: boolean` overrides the gate in either direction
  on any provider, and lands at both layers — per-agent config and
  Membrane's default for internal callers (compression/merge) — for
  accounts/regions whose entitlements differ from the GA table.
  `cacheTtl` is withheld at the host layer on bedrock (Agent Framework
  still supplies its own default downstream; membrane ≥ 0.5.77 strips
  the ttl field at the provider boundary, so the wire request never
  carries it either way). Verified live 2026-07-31: every currently
  invokable Claude on Bedrock (all 4-era; 3.5-era and opus-4-0514 are
  EOL there) writes and reads the cache cleanly. Requires
  `@animalabs/membrane` ≥ 0.5.77 (cache_control ttl strip, stream cache
  usage capture, 4-era inference-profile model mapping); the dependency
  and lockfile are bumped accordingly in this change.

- **Subscription-GC closes carry honest provenance and respect explicit
  opens** (Discord issue #5, the Mythos "channel settings keep resetting"
  mechanism). GC closes are now recorded as `subscription-gc`, never
  `agent-tool`; a channel the resident/operator explicitly opened is no
  longer auto-closed under the *default* budget — a configured per-channel
  numeric budget in `agent_settings.channel_idle_limits` counts as an
  explicit idle lease and still closes at that budget. (The override state
  records no actor — agent, operator, or imported are all possible — so
  receipts say `configured-budget`, claiming no more than the state
  proves.) Pins and policy-opened channels behave as before. Requires
  agent-framework with machine-close provenance; against an older
  framework GC behaves as it did.
- **GC closes emit an operator-side ops receipt** (`subscription-gc-close`
  via the framework ops channel: failures.log + `ops:alert` trace +
  webhook) naming channel, threshold, decision source, and the restore
  action — ids and thresholds only, no content. A durable listening-state
  change no longer looks spontaneous from outside the transcript.

## 0.7.2 — 2026-07-27

### Added

- **`LLM_CALLS_FULL_PAYLOADS` env flag** — retain the raw request on every
  llm-call log entry, not only on refusal/error. Debugging aid; off by
  default (the logs grow gigabytes fast with it on).

## 0.7.1 — 2026-07-26

### Changed

- **Health call stats are now per-call, not cumulative.** The previous version
  rolled everything into two totals (main / compression), which hid exactly what
  you want to see — how an individual turn behaved. Now one row per call, newest
  first: time, origin, messages, fresh input, cached tokens, cached share, cache
  write, output, breakpoints, duration and verdict, with refusals and errors
  highlighted. Cumulative totals for the session remain in the Usage panel.

## 0.7.0 — 2026-07-26

### Added

- **Health panel: recent LLM call stats, split main vs compression.** Aggregates
  the call ledger the client already receives — fresh input, cache read/write,
  **cached share** (cacheRead ÷ input+cacheRead: what fraction of the prompt was
  reused rather than re-read), prefix-reuse rate, output, average cache
  breakpoints, cost, and errors/refusals — separately for `turn~` (main) and
  `aux~` (compression/summarizer). Includes the last 8 fresh-input values per
  group, so a budget descent can be seen trending down.
  - The `~` is honest: origin is inferred from stream-vs-complete (turns stream,
    compression uses `complete()`), not a definitive tag. Stated in the panel.
- **Health panel: context composition of the last compile** — head / raw middle /
  summaries by level / tail, with shares and bars. Sourced from `/healthz`, which
  now carries the strategy's in-process render stats: unlike
  `/debug/context/makeup` this costs nothing and makes no `count_tokens` network
  call, so it is safe on the 15s health poll.

## 0.6.1 — 2026-07-26

### Fixed

- **Pin id picker sourced the wrong ids.** It read `/debug/context/curve`, which
  looked right but isn't: on a live store 0 of 208 raw entries carried a
  `sourceMessageId`, and the 26 entries that *did* have an `id` were summaries,
  whose ids (`L3-544`) are not message ids. Pinning with one would have created a
  pin matching no message and silently done nothing. The picker now uses the
  client's own message list, where `WelcomeMessageEntry.id` is the store id and
  server-sourced rows are exactly those carrying a store `index`; it also gains a
  text/id filter. Caught by checking the endpoint against a real store before
  anyone used the panel.

## 0.6.0 — 2026-07-26

### Added

- **Pins panel** — operator control over protected ranges, using the pin surface
  that already existed in context-manager (`pinRange` / `markDocument` / `unpin`
  / `listPins`). No cm or af change was needed.
  - Three semantics kept visibly distinct rather than collapsed into one "pin",
    because they do different things to the fold plan: **raw** (never folded),
    **max L<sub>k</sub>** (fold no deeper than k; k=0 ≡ raw), and **at
    L<sub>k</sub>** (pinned at exactly k — the frontier cut passes through that
    node).
  - `at L_k` is honored **only** by `foldingStrategy: 'kv-stable'`; elsewhere it
    degrades to raw. The panel detects this and warns, rather than letting a
    request silently mean something else.
  - Ids are pickable from `/debug/context/curve` (~14ms, the cheapest debug
    endpoint and the only one exposing per-entry store ids with a text preview),
    so ranges are selected from the live context instead of pasted by hand.
    Entries without a store id — merged summaries — are omitted, since a pin
    needs a message id.
  - New `request-pins` / `pin-add` / `pin-remove`, server frame `pins-list`,
    broadcast on change like `settings-state`: pins alter what the next compile
    folds, so operators must not hold divergent views. Full-auth only via
    `observerMaySend`'s default-deny. `level` and `maxLevel` together is rejected
    at the wire as ambiguous.
  - Pins take effect on the next compile — no restart — and pair with dry run,
    which is now ~1.6s rather than minutes.

### Fixed

- Dry-run cost text said "~8s"; measured ~1.6s after the context-manager solver
  fixes. Corrected rather than left pessimistic.

## 0.5.4 — 2026-07-26

### Corrected after release

- The `0.5.4` note below claimed the entry projection fixed the 110s stall. **It
  did not.** Re-measuring after the change showed 121,855ms — unchanged. The
  projection cut payload (megabytes → 265KB) and removed the blob-inlining heap
  exposure, both worth keeping, but the time was never serialization. The actual
  cause was an O(members × groupSize) cliff in three kv-control solver loops,
  triggered whenever a head/tail boundary falls inside a deep summary group —
  fixed in context-manager (`1c4c436`, `7f2d5e1`; see
  `docs/incremental-compile-problem.md` §9.3). Measured after that fix: dry run
  **1.56s**, dry run + render **1.69s**, live compile 22.5s → 2.4s.

### Fixed

- **`dry run + show context` was a 110-second agent stall.** Measured 110,348ms
  against ~8s for the numbers-only dry run. `select()` builds the rendered
  entries either way, so the extra ~102s was pure serialization of 353 full
  entries — content the pane never showed, since it truncated every body past
  600 chars. The server now projects to `{i, who, chars, media, truncated,
  text}` with text capped at 1,200 chars; content blocks never leave the
  process and media is counted rather than inlined, which also removes the
  blob-resolution heap exposure `/curve` warns about.
- The cost disclosure was understated by ~20× and in the dangerous direction
  ("seconds… briefly pauses the agent"). It now states that the compile runs on
  the agent's thread and the agent does nothing else meanwhile, quotes the
  measured cost, and notes runs are serialized so a second click is refused
  rather than queueing another pause.

## 0.5.3 — 2026-07-26

### Added

- **Dry-run buttons, and the resulting context in the main pane.** Settings now
  has explicit `dry run` and `dry run + show context` buttons; the latter
  renders the context those settings WOULD produce in a new main-pane view,
  behind an unmissable "dry run — not applied" banner. Entries come from
  context-manager's dry-run select, so it is the actual layout, not an estimate.
- Dry runs report how long they took, and the panel states the cost up front: a
  full compile, seconds on a large store, briefly pausing the agent.

### Fixed

- **Preview no longer fires on every keystroke.** It was debounced-on-input, but
  a dry run is a real compile and `select()` is synchronous — so each one blocks
  the agent's event loop (no heartbeat, no Discord, no MCPL). Typing a budget
  stacked those stalls and made the UI look hung. It is now operator-initiated
  only, with server-side single-flight and a 3s cooldown that returns 429 rather
  than queueing more agent pauses.
- `middleChunkCount` was labelled "middle chunks" but the adaptive picker's unit
  is the MESSAGE (14,057 for a store with 800 chunks). Relabelled "middle
  messages (picker units)".
- The sidebar was `w-72` (288px) and clipped the dense numeric tables; now
  `w-96`, wider still on xl displays.

## 0.5.2 — 2026-07-26

### Fixed

- **Settings preview reported unreachable budgets as fitting.** context-manager's
  `PreviewResult.budgetTokens` is the *rejection* budget —
  `(requested - reserve) * (1 + overBudgetGraceRatio)` — and its `fits` means
  "would not throw `OverBudgetError`", not "fits the budget you asked for". On
  Mythos (`overBudgetGraceRatio: 0.35`) those differ by a third: previewing
  250k reported `fits: true` at 273,828 tokens, a budget the picker had in fact
  exhausted trying to reach. The endpoint now returns an `accounting` block
  separating `fitsRequested` / `withinGrace` / `unreachable`, and the panel
  renders three distinct verdicts (fits / over-requested-but-graced /
  would-hard-fail) plus the full budget derivation.

## 0.5.1

### Added

- **llm-calls logging for every provider**: `LoggingProviderAdapter`, a
  provider-agnostic decorator over any `ProviderAdapter`, wraps the
  openai-codex, openrouter, and openai-responses transports — which
  previously had NO wire visibility (found post-deploy on Mica: zero
  llm-calls files, requests undiagnosable). Full raw request + response
  summary + usage + timing + error per call, size-guarded against
  pathological payloads. Anthropic/Bedrock keep their purpose-built
  logging classes.

## 0.5.0 — 2026-07-26

### Added

- **Context settings panel** (webui `Settings` tab) — live control of the
  agent's compile window, replacing the stop → edit the `framework/state`
  Chronicle slot → start dance. Edits `contextBudgetTokens`, `tailTokens` and
  `transitionPaceTokens`; Apply / reset-to-recipe / revert-edits, plus cancel
  for an in-flight descent.
  - New client messages `request-settings`, `settings-update`,
    `settings-reset`, `settings-cancel-transition`; new server frame
    `settings-state`. No protocol version bump (additive).
  - `settings-state` is **broadcast** to every welcomed client, unlike
    `mcpl-list` — these are live process values, so two operators must not see
    divergent budgets.
  - Mutations are full-auth only for free: `observerMaySend` denies by default,
    so new message types are never reachable by scoped observers.
  - `persist: false` applies ephemerally (live now, reverts on restart) for
    operator experiments. `notify: true` optionally pushes a notice to the
    agent; **off by default**, because the notice is new text in the very
    context being tuned — it invalidates the KV prefix and is itself
    classifier-visible. The agent can always pull current settings via its own
    `agent_settings` tool instead.
  - The panel is explicit about three things that would otherwise mislead:
    raising the budget applies at once but **lowering starts a paced
    convergence** (shown as `converging` / `blocked`, with the blocked reason
    spelled out); only a few keys are hot, so `targetChunkTokens`,
    `headWindowTokens`, `mergeThreshold`, `foldingStrategy` and friends are
    listed under "restart only" rather than offered as controls; and preview
    requires a context-manager with dry-run support, so an older build reports
    "preview unavailable" instead of rendering an empty result.
- **`GET /debug/context/preview?budget=&tail=[&agent=]`** — non-committing
  preview of the fold plan at a hypothetical window. Persists no fold
  resolutions, enqueues no compression, advances no transition bookkeeping
  (the guarantee lives in context-manager's dry-run select). An infeasible
  budget is reported as `fits: false` with per-component diagnostics rather
  than an error — learning a budget cannot work is the reason to preview
  instead of applying and taking the outage. Returns 501 when the resolved
  context-manager predates dry-run support. Requires the `debug` scope.

### Fixed

- `/debug/context/curve` compiled against `app.recipe.agent.contextBudgetTokens`
  — the **stale recipe** value. Runtime overrides live in the `framework/state`
  Chronicle slot and win over the recipe, so the curve was plotted at the wrong
  budget for any agent whose budget had ever been changed at runtime. Now reads
  the live `getAgentRuntimeSettings`, falling back to the recipe.

## 0.4.0

### Changed

- **context-manager ^0.6.0** — the fatal coverage invariant: a compile
  refuses (`OverBudgetError` / `UncoveredDropError`) rather than shipping a
  context with silently-dropped messages, and recall-pair pricing includes
  reasoning carriers (fixes the permanent compile wedge / silent middle loss
  on carrier-bearing stores). Default `overBudgetGraceRatio` is now 0.02.
- **agent-framework ^0.7.0** — host-side recovery for context refusals: the
  OverBudget drain breaker also kicks for `UncoveredDropError`, and a
  `context-refusal` ops alert fires immediately (fleet-watch) with the
  recovery knobs named. Plus the context-settings preview surface and the
  workspace read cap.

### Added

- `compressionMaxTokens` recipe passthrough — cap compression output for
  models with low output ceilings (2c78936).

### Fixed

- **TUI bug sweep** (#64): operator-safety and observability fixes.
  - `/quit` confirm no longer treats arbitrary input as consent — only an
    explicit `y`/`yes` (or re-typed `/quit`) kills fleet children, `d`
    detaches, anything else cancels; a typed-through message is restored to
    the input (paste referents intact) instead of discarded. Ctrl+C now goes
    through the same confirmation; a second Ctrl+C force-quits.
  - `/checkpoint` records the message position and `/restore` branches back
    to it (previously restored to the branch head — rolling back nothing);
    repeat restores at the same position are a no-op, and an unreachable
    position degrades to the branch head with an explicit note.
  - Session switch fully resets TUI observability state (tree aggregator,
    stream subscriptions, per-agent caches) — fleet subtrees no longer
    freeze after `/session switch`.
  - Memory: peek logs / transcripts / scrollback capped, and detached
    renderables are `destroy()`ed so their native text buffers are actually
    freed (the fleet view leaked one buffer per line per 500ms repaint).
  - Agent-name resolution is exact (`shortAgentName`, fork `-d{depth}`
    scheme included) instead of substring matching that cross-wired agents
    with prefix-overlapping names; peek tails no longer clip the newest
    lines; fleet-view kill/restart failures are surfaced; per-round context
    size (`ctx:`) and session totals (`Σ`) are separate status segments;
    synesthete summaries moved off the render path and back off 30s after
    a failed call instead of retrying at 2 Hz.
  - Smaller UX: peek works on finished subagents (final runtime shown),
    fork `done` summaries always print a chat line, Esc/Ctrl+B work from
    the fleet view, paste placeholders survive `]` in the pasted text,
    `/help` documents `/find` and `/branchto`, `/clear` with arguments
    clears.

### Docs

- Synced stale documentation with the current build: repos marked public
  (AGENT-ONBOARDING), `forking-knowledge-miner` → `connectome-host`
  naming, webui default port corrected to 7340, DEV-ENVIRONMENT
  branch/version table refreshed (all feature branches merged),
  LOCUS-ROUTING and both root plan docs marked implemented.

### Changed

- **Tool-bloat reduction**: subscription-gc's `set_channel_idle_limit` /
  `list_channel_idle_limits` tools folded into `agent_settings` as the
  `channel_idle_limits` field (per-entry merge; number / `"off"` /
  `"default"`-or-null to clear), following the reasoning-controls
  precedent. The old tool names remain routable (undeclared), so agent
  muscle memory keeps working; agents just no longer carry the two extra
  tool schemas. `get` also reports read-only `channel_idle_default`,
  `channel_idle_counters`, and `channel_idle_pinned`, preserving what
  `list_channel_idle_limits` exposed. Updates are all-or-nothing: a patch
  with any invalid entry applies none of its entries.
- **GC pins split from agent overrides**: ChannelModeModule now holds
  debounced channels open via an internal `pin_channel_idle_limit` verb
  and a separate pins layer, instead of writing an `"off"` override.
  Consequences: a blanket `agent_settings reset` clears only agent-set
  limits — it can no longer silently re-enable auto-close on a channel in
  debounced mode — and a pre-existing agent override now survives a
  debounced→mentions round-trip rather than being reset to default.
  (Pins persisted by earlier builds as `"off"` overrides stay agent-level
  until the next mode change re-asserts them as pins.)

## 0.3.10 — 2026-07-21

### Added

- **Provider transports**: `provider: "bedrock"` for legacy Claude models
  (3.5 Sonnet 0620/1022, Opus 3) surviving on AWS APAC after Anthropic API
  retirement — AWS_* env credentials, model-ID mapping via membrane, prompt
  caching forced off (legacy models reject `cache_control`; verified live).
  `provider: "openai-codex"` (ChatGPT subscription, device-code login,
  `/fast` toggle) and `provider: "openrouter"` formalized with validation.
- **Bedrock wire logging**: `LoggingBedrockAdapter` writes
  `llm-calls.<iso>.jsonl` on the bedrock path — tool names per request,
  stop_reason + block shapes per response, raw request retained on errors.
- **Prefill-era bot migration**: recipe `agent.formatter: "anthropic-xml"`
  (membrane classic prefill) + `agent.prefillUserMessage` scaffold — together
  reproduce a chapterx borg's exact prompting structure inside a resident
  (first used for the Supreme Sonnet isekai, 2026-07-21).

- Contribution policy: `CONTRIBUTING.md` (how changes land, review process,
  AI-attribution convention, changelog rules — binding for PRs and direct
  pushes, humans and AIs alike) and a PR template.
- CI `changelog` check: PRs touching `src/` must also touch `CHANGELOG.md`,
  opt out with the `no-changelog` label. The publish workflow now refuses to
  release a `vX.Y.Z` tag with no matching `## X.Y.Z` changelog section.
- Release mechanics automated: `npm version <level>` cuts `Unreleased` into
  `## X.Y.Z — date` via the `version` hook (`scripts/release-changelog.ts`),
  and on release tags CI creates the GitHub release with that section as
  its notes — independent of the npm publish job, so notes exist for
  github-clone consumers even when a publish fails.
- **Web UI observability catch-up**: `ops:alert` traces render as persistent
  banner rows in the SPA (compression quarantine, refusal streaks,
  inference-exhausted; `<kind>-clear` stands them down); a Health sidebar tab
  polls `/healthz` for per-agent status, failure streaks, refusal stats,
  runtime settings, and quarantine, and reconciles durable-state alerts on
  connect. New protocol frames `request-branches`/`branches-list` back a
  Chronicle branch-lineage panel opened from the header branch chip, with
  checkout via the existing `/checkout` command path (read-only for
  observers; listing rides the `messages` scope). The `/curve` link now
  lives in the Context panel header.
- **TUI modernization**: `p` on an agent inside a fleet child opens an
  honest per-agent peek — the child's event stream filtered by `agentName`,
  covering the child's root agent and its subagents (sub-subagents of the
  parent), with phase/tokens/task header from the tree reducer. `ops:alert`
  traces from the local framework AND from every fleet child surface as red
  chat lines plus a persistent `⚠ N alerts` status-bar segment; all-clears
  stand alerts down. The token line now shows the session cost estimate
  when priced.

### Fixed

- Dead `PlaceholderPanel` removed from the SPA; stale doc pointers
  (`WEBUI-PLAN.md`, knowledge-miner references) corrected; README now
  documents the web UI, headless mode, and current TUI peek semantics.

## 0.3.2 — 2026-07-14

Retro-filed: 0.3.1–0.3.9 predate the changelog policy and were released
without cutting this file; only the entry below was recorded at the time.

### Breaking (recipe authors only)

- `modules.fleet.children[].recipe` paths now resolve at recipe-load time
  against the **directory of the parent recipe file** (or URL base) rather
  than `process.cwd()`. Absolute paths and `http(s)://` URLs pass through
  unchanged. This makes recipe bundles portable: a parent file and its
  sibling children can live anywhere on disk and be launched from any CWD.

  **Who needs to act**: anyone maintaining a forked or custom
  triumvirate-style recipe that hard-codes child paths with a `recipes/`
  prefix (or any prefix anchored at `connectome-host/`'s CWD). After
  upgrade, `"recipes/knowledge-miner.json"` inside
  `<somewhere>/my-recipe.json` resolves to
  `<somewhere>/recipes/knowledge-miner.json`, which is almost certainly
  not what's intended.

  **Migration**: drop the `recipes/` prefix so the child is referenced as a
  sibling of the parent file (e.g. `"knowledge-miner.json"` or
  `"./knowledge-miner.json"`). No files need to move on disk. The
  in-tree `recipes/triumvirate.json` has already been updated.

  **Unchanged**: `dataDir`, workspace mount paths, and child process CWD
  stay CWD-relative (these are runtime paths, not authoring references).
  `fleet--launch` invocations from the conductor are still matched
  CWD-relative at dispatch time, so existing system prompts that document
  CWD-relative paths continue to work.
