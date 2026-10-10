- `openai-codex` can run through an inference gate that holds the ChatGPT
  logins (the gate's `/codex` leg): set `CODEX_GATE_TOKEN` and point
  `CODEX_BASE_URL` at the gate. No Codex CLI or login runs on the host, the
  gate chooses the account, and a gate token is never sent without an
  explicit `CODEX_BASE_URL`. The subscription quota meter is off in this
  mode (the gate tracks utilization per login).
