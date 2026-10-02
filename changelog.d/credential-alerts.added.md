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
  of rendering nothing when a subscription meter has never read.
- **Activity module: jam notices (opt-in) and honest typing.** With
  `modules.activity.jamNotices: true`, a subscribed channel that receives a
  message while the host is jammed (spent quota, expired/rejected credential,
  pending login, hard-down) gets one host-attributed "cannot respond right
  now" line per episode, with the expected reset time when known, and one
  "can respond again" line when the jam clears; one chronicle marker per
  episode tells the agent the host spoke for it. The typing indicator now
  also stops on `inference:failed` / `inference:exhausted`, not only on a
  completed turn.
