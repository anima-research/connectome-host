# Subscription transport ownership

`CodexSubscriptionAdapter` is a host lifecycle wrapper around Membrane's
`OpenAIResponsesAPIAdapter` in subscription mode. `CodexAppServerAuth` retains
Codex CLI startup, device login, credential-file reading, refresh-token rotation
via app-server, and disposal. The wrapper passes a fresh token/account snapshot
to Membrane and forwards Fast mode fallback warnings to the host console.

Recipes continue to select `openai-codex`; Fast controls and `CODEX_BASE_URL`
retain their existing behavior. The host adapter retains the `openai-codex`
label. Its logging decorator forwards both `usageCacheConvention` and
`requiresNativeResponsesInput`, so Membrane normalizes usage and honors the
participant-aware formatter used by auxiliary calls. Direct provider usage is
cache-inclusive; Membrane supplies disjoint fresh/cached usage to the host.
Logs preserve raw provider counts with an explicit `cacheConvention` marker.

The transport's endpoint, filtering of unsupported parameters, SSE parsing,
error classification, output reconstruction, and provider usage convention now
have one implementation in Membrane. Authentication retries happen there only
for HTTP 401, once per request, before any streamed output. A 403 is surfaced
without forcing a token refresh.

## Companion dependency

The shared transport ships in `@animalabs/membrane` 0.5.85
([Membrane #74](https://github.com/antra-tess/membrane/pull/74), released
2026-09-14). This host depends on `^0.5.85`; agent-framework and
context-manager resolve the same copy through their own caret ranges, so no
override is needed and both lockfiles carry the registry package. During review
the branch temporarily pinned the PR-branch commit as a git dependency; that
pin never reached a host release.

[Membrane #75](https://github.com/antra-tess/membrane/pull/75) separately adds
Anthropic's rotating-credential seam for issue #69. This OpenAI host migration
does not require it and does not change Anthropic credential acquisition.

## Credential state, alerts and operator actions

The host keeps ONE named state for its subscription credential
(`src/credential-state.ts`) and moves every transition through the ops-alert
pipeline (failures.log, `ops:alert` trace, `CONNECTOME_OPS_WEBHOOK`), so the
TUI status bar, the WebUI alert strip and a fleet parent all learn about it on
the wire they already watch. Kinds and what feeds them:

| kind | fed by | lifts when |
|---|---|---|
| `quota-spent` | quota meter: a non-advisory window at 100% for this agent's model | the meter reads the window below 100% / past its reset |
| `quota-unreadable` | quota meter: three consecutive failed reads and never a good one (inference-only tokens answer 429 on the usage path) | the first good read |
| `auth-expiring` | credential file `expiresAt` within 30 min | a rotation, or supersession by a 401 |
| `auth-expired` / `auth-rejected` | a 401 (membrane `type: 'auth'`) seen by the logging adapters; `expired` when the file's expiry has passed | the next successful call, or a passing probe after an action |
| `auth-login-required` | the Codex app-server's device-code prompt (URL + code ride in the alert) | the login completes |

Each alert's `data.actions` lists what the host can run for that state:
`refresh` (rotate with a refresh token / the app-server), `login` (Codex
device-code flow; `account/logout` first when supported), `set-token` (an
operator paste, kept in memory and written to the credentials file when one
was loaded), `recheck` (usage probe + meter read). The WebUI renders them as
buttons on the alert row and in the Health tab's credential section (WS
`credential-action`, broadcast answer `credential-state`; `request-credential`
and `GET /credential` read the state; both scope to fleet children over the
panel IPC). The TUI names the matching command in the alert line:
`/auth [status|refresh|login|recheck|token <tok>]`.

Nothing rotates on its own. Membrane retries a 401 once with `forceRefresh`;
the Anthropic source answers that with the SAME token unless
`ANTHROPIC_OAUTH_AUTO_REFRESH=1`, so an expired credential becomes an alert
with a "Refresh token" button rather than a silent rotation. The Codex adapter
keeps its existing automatic app-server refresh on that retry.

### Anthropic credential sources

- `ANTHROPIC_AUTH_TOKEN` — a bare bearer (typically `claude setup-token`):
  no refresh token, no known expiry, not host-rotatable. The only action is
  `set-token`.
- `ANTHROPIC_OAUTH_CREDENTIALS_FILE` — a JSON file in Claude Code's shape
  (`{ "claudeAiOauth": { "accessToken", "refreshToken", "expiresAt" } }`) or
  the same three keys flat. With a refresh token the host rotates at
  `https://platform.claude.com/v1/oauth/token` (JSON grant, Claude Code's
  public client id) and writes the new pair back to the same file, mode 0600.
  Point it at a COPY of `~/.claude/.credentials.json`, never at that file:
  refresh tokens may be single-use, and two processes refreshing from one file
  invalidate each other. The refresh exchange follows the CLI's own request
  shape; it has not yet been exercised against the live endpoint from this
  host — the first operator "Refresh token" click is that verification.

### Channel-side notices

A jammed host is silent on the channel side: a quota hold parks the request
before inference starts, so not even the typing indicator appears. The
`notices` module (`modules.notices`) closes that gap for every outage the
framework can name, not only credential ones: it is a sink of the `ops:alert`
stream, and decides where and how loudly each alert kind is told.

```json
"modules": {
  "notices": {
    "statusChannels": ["zulip:ops"],
    "reply": { "in": ["zulip:*"], "not": ["zulip:general"] },
    "kinds": { "hard-down": "reply", "auth-*": "reply", "refusal": "silent" },
    "quietMs": 60000
  }
}
```

- `reply` kinds (by default: `hard-down`, `quota-spent`, `auth-expired`,
  `auth-rejected`, `auth-login-required`, `provider-hold`) mean the agent
  cannot answer. A person who writes to it in a channel matching `reply.in`
  gets one canned host-attributed line per episode ("cannot respond right
  now: its subscription quota is spent. Expected back after …"), the channel
  whose message triggered the failing turn is told the same, and every
  channel that was told gets one "can respond again" line when the outage
  ends. `reply.in` / `reply.not` are channel-id patterns, so "notify on
  Zulip, never on Discord" is one line. Public channels never see error text.
- `status` kinds (`context-refusal`, `mcpl-down`, `quota-unreadable`,
  `auth-expiring`, …) and all `reply` kinds also go to `statusChannels` with
  the operator-grade message (kind + error text). Status channels follow the
  kind-level timeline: one line once a kind has been active for `quietMs`
  (so a flap that resolves in seconds says nothing), one line when a told
  kind clears, naming what remains.
- `silent` kinds (`refusal`, and anything unknown) only reach failures.log
  and the webhook as before.

Episodes close on the kind's `-clear` alert, or, for framework kinds with no
clear (`hard-down`, refusals), on the agent's next completed inference; an
`mcpl-down` episode closes when that server reconnects. Channel ids are opaque
and resolved at post time: a notice whose chat server is itself down is parked
on the episode and delivered if the server comes back while the outage is
still on, else dropped. The publish path carries no topic, so on Zulip a
notice lands in the stream's default topic. One chronicle marker per episode
tells the agent, on recovery, that the host spoke in its channel.

## Remaining authentication integration

- The framework's provider hold is still stderr-only and its release is
  private (agent-framework): a quota hold is announced here from the host's
  meter reading, not from the hold itself, and a rotated credential waits for
  the next hold slice (≤10 min) before the parked agent is retried.
- Codex acquisition currently shares one app-server login across callers.
  Aborting inference stops waiting and prevents HTTP, but does not stop that
  shared login ceremony. Cancellation must be coordinated across all callers
  before terminating it, so one aborted request cannot cancel another's login.
  Explicit host disposal still stops app-server and clears pending RPCs.

Co-authored by GPT-6 via OpenAI Codex.
