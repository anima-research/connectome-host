- Docs that said something the host doesn't do now say what it does. What the
  host does is unchanged:
  - **Command line and environment:** the model defaults to `gpt-5.4` for an
    `openai-codex` recipe. Recipe provider `anthropic` needs one of
    `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
    `ANTHROPIC_OAUTH_CREDENTIALS_FILE`, not the API key in particular.
    `sleep-privileged.json` is read from the working directory, not the
    install. Batch mode reads all of stdin first, and waits for a line's turn
    before it takes the next line. Headless mode's doc names the fleet
    protocol's `IncomingCommand` and `WireEvent` in place of a partial list.
    `setup.ts` checks each systemd service it finds running from its
    directory, and says what the service needs where it finds none or can't
    ask systemd. The agent overlay's path is `MCPL_AGENT_OVERLAY_FILE` where
    the environment sets it. The recipe argument is the first that doesn't
    start with `--`: every `--` flag is passed over, not only `--no-tui` and
    `--no-recipe`.
  - **Recipes:** a keepalive's read costs the model's cache-read price, 0.1x
    for most models. An MCPL server may give both `command` and `url`, with
    `transport` saying which to use. A fleet launch of a recipe outside
    `allowedRecipes` has no approval step: it fails, telling the agent to ask
    the user to extend the list, and with neither the list nor a recipe in
    `children` there is no allowlist. `ttsRelay` isn't a pure tap: an
    interruption puts a note in the agent's context. `subscriptionGc` and
    `channelMode` read nothing from `toolPrefix`, and `subscriptionGc` leaves
    a channel the agent opened itself open unless a limit is configured for
    it, and a tuned-out channel alone. A read-only `instructions` mount's
    edits reach `workspace--read` too.
  - **MCPL server files:** `mcpl-servers.json` and the agent overlay can hold
    credentials, in env values and a token. A recipe can set a file server's
    `token` and `access` too. A server file entry doesn't carry every
    serializable field of agent-framework's server config: `requestTimeoutMs`
    is one it leaves out.
  - **Fleet protocol:** `shutdown`'s `graceful: false` runs the same shutdown
    and changes only the reason `lifecycle:exiting` gives. A `panel-request`
    takes any of `PANEL_OPS`, six of which the old list left out. A snapshot's
    `asOfTs` is compared with events' `ts`. A wire event can be a command's
    response. A child's early output reaches `startup.log` only where the
    fleet could open it.
  - **Web UI protocol:** an observer's `welcome` comes once its
    `observer-hello` verifies, and an `error` for a failed hello is followed
    by the server closing the connection. A connection without full authority,
    basic auth or a full session cookie, gets `observer-auth-required`.
    `branch-changed` is followed by a fresh `welcome`. `session-changed` is
    never sent: a session switch re-welcomes every client. A credential's
    fields are top-level, and all but `type`, `scope` and `subscription` are
    absent on an API-key host. The settings' `overrides` include keys not
    persisted. Host mode's `since` is when the quiesce began. An operator
    action can fail with code `'failed'`. A pin's `level` is honoured under
    `kv-stable`, and under `kv-unified` with adaptive resolution. An observer
    grant is protected only when its file entry says so: the tools can't make
    one.
  - **HTTP routes:** every route answers GET and HEAD only, and isn't
    read-only: `/debug/context?injections=1` runs gathers and hooks, and a
    compile of `/debug/context` or its `makeup` releases a compression hold
    whose deadline has passed. `/healthz` also opens to a full session or an
    observer's `health` scope. `/debug/context` reads `agent`, `injections`
    and `pretty`, and no `hooks`. `withinGrace`, in a context preview's
    accounting and the curve's verdict, is true when the plan fits the request
    as well. A context preview's `elapsedMs` is its compile's time, which the
    agent is paused for at least. `lastBilledInputTokens` is null from a
    stream's start until a call reports one. The `/ws` check accepts an
    `Origin` whose host and port are the request's `Host`, whatever its
    scheme.
  - **Logs:** the Anthropic call log keeps no normalized request. Of a
    response that holds tool calls under a stop reason other than `tool_use`,
    membrane runs the complete calls only when that reason is a literal
    `end_turn`, not when there is none. Gate telemetry's doc no longer names a
    `streamed` flag: the call log records the lane in `kind`.
  - **Slash commands:** `/history [n]` shows the last n messages, 20 by
    default. `/bug` copies a frame's package-relative path in the host's own
    code, cuts the report to fit the link, saying what it leaves out, and says
    so when it can't save the file.
  - **Extensions:** an extension gets the host's `@animalabs/*` versions only
    where its imports resolve to the host's `node_modules`, and nothing checks
    that they do.
  - **Scripts:** `evacuator.ts` detects the model from `conversations.json`,
    has that model adjust the prompt at step 3, opens `memories.json`'s
    `conversations_memory` entries at step 5, and aborts on an empty buffer at
    step 4. `warmup-session.ts --max-spend` stops between ticks once the
    script's own estimate reaches it. `import-claudeai-export.ts` doesn't
    import thinking summaries, and picks at each branch the subtree holding
    the latest `created_at`. `audit-module-optins.ts` skips `web/` too, and
    counts only source recipes toward exit 2. `connectome-doctor`'s delivery
    stage is the agent log's last write.
