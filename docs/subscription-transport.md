# Subscription transport ownership

`CodexSubscriptionAdapter` is a host subclass of Membrane's
`OpenAIResponsesAPIAdapter`, constructed in subscription mode, that adds login
lifecycle on top. `CodexAppServerAuth` retains
Codex CLI startup, device login, credential-file reading, refresh-token rotation
via app-server, and disposal. The subclass hands Membrane a credential resolver
that returns a fresh token/account snapshot, and forwards Fast mode fallback
warnings to the host console. It also exposes `readRateLimits()` (app-server
`account/rateLimits/read`, no inference), which feeds the host's quota meter —
the WebUI's `/quota` windows.

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
2026-09-14). This host now depends on `^0.5.86`; agent-framework and
context-manager resolve the same copy through their own caret ranges, so no
override is needed and both lockfiles carry the registry package. During review
the branch temporarily pinned the PR-branch commit as a git dependency; that
pin never reached a host release.

[Membrane #75](https://github.com/antra-tess/membrane/pull/75) separately adds
Anthropic's rotating-credential seam for issue #69. This OpenAI host migration
does not require it and does not change Anthropic credential acquisition.

## Remaining authentication integration

- Anthropic host integration remains tracked alongside Membrane issue #69: the
  host must supply a live credential source instead of its startup environment
  string. That source must define storage, refresh serialization and login UI;
  merely re-reading the environment does not rotate expired credentials.
- Codex acquisition currently shares one app-server login across callers.
  Aborting inference stops waiting and prevents HTTP, but does not stop that
  shared login ceremony. Cancellation must be coordinated across all callers
  before terminating it, so one aborted request cannot cancel another's login.
  Explicit host disposal still stops app-server and clears pending RPCs.

Co-authored by GPT-6 via OpenAI Codex.
