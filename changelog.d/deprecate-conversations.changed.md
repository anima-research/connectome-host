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
