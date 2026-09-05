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
