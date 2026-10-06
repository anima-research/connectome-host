# Debug Context API

`GET /debug/context` returns the **membrane-normalized request that would be
emitted if an agent were activated right now** — without activating it. It is a
window into exactly what the model would see on its next turn: the
compiled message history, the assembled system prompt, the generation config,
and the filtered tool set.

Use it to answer questions like:

- "What does the agent's context actually look like after compression?"
- "Is my system prompt / injected content showing up the way I expect?"
- "Which tools is this agent allowed to call right now?"
- "How many messages survived the context strategy's selection?"

It is served by the `webui` module over the same HTTP server as the web UI, so
it inherits that module's auth and bind configuration. If you haven't set up
`webui` yet, read [`webui-deployment.md`](./webui-deployment.md) first.

## Prerequisites

1. **`webui` is enabled** in your recipe — as an object with `basicAuth` (or a
   loopback `host`); `"webui": true` alone binds `0.0.0.0` without credentials
   and the host refuses to start.
2. **Auth is configured.** The default bind is `0.0.0.0`, which *requires*
   `basicAuth` — the host refuses to start otherwise. Every request to
   `/debug/context` must then carry those Basic-Auth credentials, the
   full-access session cookie set by `/auth/basic`, or an observer session
   whose grant includes the `debug` scope (see
   [`webui-deployment.md`](./webui-deployment.md#authentication)). (A
   loopback-only bind, `host: "127.0.0.1"`, skips the auth requirement for
   local dev.)

```jsonc
// recipe.json
{
  "modules": {
    "webui": {
      "basicAuth": { "username": "${WEBUI_USER}", "password": "${WEBUI_PASS}" }
    }
  }
}
```

> **Treat the response as sensitive.** It contains the full system prompt and
> the entire compiled conversation. It is gated by the same auth as the rest of
> the surface — don't expose it more widely than the web UI itself, and grant
> observers the `debug` scope deliberately.

## The endpoint

```
GET /debug/context
```

| Query param   | Default        | Meaning                                                              |
|---------------|----------------|----------------------------------------------------------------------|
| `agent`       | recipe's root agent | Which agent to preview. Use a subagent's name for a child.      |
| `injections`  | *(off)*        | Any value other than `0`/`false` (e.g. `1`) gathers dynamic injections too. **Not transparent** — see below. |
| `pretty`      | *(off)*        | Any value other than `0` (e.g. `1`) pretty-prints the JSON (2-space indent). |
| `scope`       | *(local)*      | A fleet child's name: answer for that child instead (see [Sibling endpoints](#sibling-endpoints)). |

### Responses

- **`200`** — JSON body (see [Response shape](#response-shape)).
- **`404`** — `{ "error": "Agent not found: <name>" }` for an unknown `agent`.
  Any unknown `/debug/*` path also gets a JSON `404`.
- **`401`** — missing/wrong credentials.
- **`405`** — any method other than `GET`/`HEAD`.
- **`503`** — plain-text `Not ready`: server up but no agent session bound yet
  (e.g. mid-restart).

## Transparent by default

This is the important part. By default the endpoint:

- runs **no inference** (spends no tokens),
- writes **no messages** to Chronicle,
- contacts **no** external MCPL server.

It compiles the context, assembles the system prompt and filters tools. That
compile is the one the agent's next turn would run, so it is not strictly
read-only: it can persist the strategy's fold-resolution state, queue
summaries its fold plan demands (the background compression then produces
them, as it would after a real turn), and settle a pending context-budget
transition — the same kinds of change the agent's own compile makes on every
turn.

The trade-off is fidelity: the default response **omits the dynamically
gathered injections** (lessons, retrieval results, MCPL `beforeInference`
context), because gathering those is *not* free or transparent:

- module `gatherContext` can run inference — e.g. the retrieval module makes configured model calls, which cost tokens and add
  latency;
- MCPL `beforeInference` hooks are arbitrary RPCs to external servers with
  side effects, and a preview never sends the paired `afterInference`, which
  can leave a stateful server half-open.

To opt into a byte-faithful preview that includes those injections, pass
`?injections=1` and accept the side effects. The response's `"transparent"`
field tells you which mode actually ran.

## Examples

Transparent preview of the root agent (the common case):

```sh
curl -fsSL -u "$WEBUI_USER:$WEBUI_PASS" \
  'https://admin.example.internal/debug/context?pretty=1'
```

A specific subagent:

```sh
curl -fsSL -u "$WEBUI_USER:$WEBUI_PASS" \
  'https://admin.example.internal/debug/context?agent=researcher-3&pretty=1'
```

Full-fidelity preview (spends tokens, fires MCPL hooks):

```sh
curl -fsSL -u "$WEBUI_USER:$WEBUI_PASS" \
  'https://admin.example.internal/debug/context?injections=1&pretty=1'
```

Local dev against a loopback bind (no auth needed):

```sh
curl -fsSL 'http://127.0.0.1:7340/debug/context?pretty=1'
```

### Handy `jq` recipes

```sh
BASE='https://admin.example.internal/debug/context'
AUTH=(-u "$WEBUI_USER:$WEBUI_PASS")

# Confirm the call was transparent
curl -fsS "${AUTH[@]}" "$BASE" | jq '.transparent'

# Count compiled messages and show who said what
curl -fsS "${AUTH[@]}" "$BASE" | jq '.request.messages | length'
curl -fsS "${AUTH[@]}" "$BASE" | jq -r '.request.messages[].participant'

# Read the assembled system prompt
curl -fsS "${AUTH[@]}" "$BASE" | jq -r '.request.system'

# List the tools this agent may call
curl -fsS "${AUTH[@]}" "$BASE" | jq -r '.request.tools[].name'

# Just the model + token config
curl -fsS "${AUTH[@]}" "$BASE" | jq '.request.config'
```

## Response shape

```jsonc
{
  "agent": "agent",          // the agent previewed
  "injections": false,       // whether dynamic injections were gathered
  "transparent": true,       // true => no injections gathered (no inference, no MCPL hooks)
  "request": {               // the membrane NormalizedRequest
    "messages": [
      {
        "participant": "user",
        "content": [{ "type": "text", "text": "..." }],
        "cacheBreakpoint": true            // present where a cache marker was placed
      },
      { "participant": "agent", "content": [ /* ... */ ] }
    ],
    "system": "…full system prompt…",
    "config": {
      "model": "<model-id>",
      "maxTokens": 16384,
      "temperature": 0.7                    // omitted if the recipe doesn't set one
    },
    "tools": [
      { "name": "send", "description": "…", "inputSchema": { /* … */ } }
    ],
    "promptCaching": true,
    "assistantParticipant": "agent"
  }
}
```

`request` is the literal `NormalizedRequest` the membrane would receive. The
fields that matter for debugging:

- **`messages`** — the compiled history *after* the context strategy has run
  its selection/compression. This is not your raw Chronicle log; it's what
  survives into the window. A trailing `[Continue]` user message may be
  appended if the last turn was the agent's (some providers reject a trailing
  assistant message).
- **`system`** — the recipe system prompt with any `system`-position
  injections appended (only when `injections=1`).
- **`config`** — model, `maxTokens`, and `temperature` (omitted when unset).
- **`tools`** — only the tools this agent is *allowed* to use (after
  `canUseTool` filtering), or absent if it has none.

## What it does (and doesn't) mirror

The preview reuses the exact request-builder the live activation path uses
(`Agent.buildActivationRequest`), so the messages, system prompt, tool set, and
config are identical to a real turn.

With `?injections=1` it additionally mirrors the real activation's injection
gathering (module `gatherContext` + MCPL `beforeInference`), making it
byte-faithful. The one thing it never does — by design — is run the inference
itself, so there is no model output in the response.

## Sibling endpoints

Same server and auth; `agent` defaults to the recipe's root agent.

| Endpoint | Returns |
|---|---|
| `/debug/context/makeup` | Segment breakdown of the compiled context (head, raw middle, summaries by level, verbatim tail) from the strategy's render stats, plus `exactTotalTokens` from Anthropic's `count_tokens` for the agent's own model (`COUNT_TOKENS_MODEL` overrides; non-Claude models get `countSource: "count_tokens_unsupported_model"` and a null total) and `lastBilledInputTokens`. Same compile as the default preview, plus one `count_tokens` call. |
| `/debug/context/coverage` | Summary-tree coverage and queued compression work — counts only, no message or summary text. |
| `/debug/context/curve` | One record per compiled entry: kind (raw / L1…Ln), rendered tokens, raw-history tokens covered, date span, text. `/curve` is its HTML visualization. |
| `/debug/context/preview?budget=<tokens>[&tail=<tokens>][&render=1]` | The fold plan at a *hypothetical* budget (and tail window), without applying it — commits nothing. Each run is a full compile that briefly blocks the agent, so runs are serialized process-wide with a 3 s cooldown (`429`). `400` for a bad `budget`/`tail`; `501` when this framework/strategy can't dry-run. |
| `/debug/context/maintenance` | Counts-only state and recent history of periodic context maintenance (no `agent`). |

`?scope=<child>` on any of these (and on `/debug/context`) forwards the request
to that fleet child over the fleet IPC and returns its JSON: `404` if no fleet
module is loaded or the child is unknown, `502` if the child isn't running or
the send fails, `504` if it doesn't answer within 30 s.

## Troubleshooting

- **`401 Unauthorized`** — add `-u user:pass`. On the default `0.0.0.0` bind
  the endpoint always requires auth (an observer also needs the `debug` scope).
- **`404 Agent not found`** — check the `agent` name. Omit the param to target
  the recipe's root agent; use the exact subagent name otherwise.
- **`503 Not ready`** — the HTTP server is up but no session is bound yet
  (common during a restart/session switch). Retry shortly.
- **`"transparent": false` when you didn't expect it** — you passed an
  `injections` value other than `0`/`false` (even an empty `injections=`).
  Drop it for a transparent call.
- **The response seems to be costing tokens** — only the `injections=1` path
  spends tokens. The default never does.
