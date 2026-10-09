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
