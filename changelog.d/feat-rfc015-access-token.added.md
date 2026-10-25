- MCPL RFC-015 delegated access: a server the recipe grants `access.token`
  by name in its `enabledCapabilities` can ask the host for a short-lived
  credential acting as the agent. The identity module mints it with a
  15-minute lifetime and reports its real expiry. Credentials are cached per
  server and audience, never handed out with under two minutes left, and
  `fresh` mints a new one. Refusals carry RFC-015's kinds. Every request is
  appended to `$DATA_DIR/access-audit.jsonl`, never with the credential.
  Nothing is wired without an explicit grant (no wildcard or parent counts)
  or without a registered identity, and servers the agent deploys for itself
  never get it. Takes effect with an agent-framework that implements RFC-015.
