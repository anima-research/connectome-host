- **Recipe authors:** one schema now gives the recipe's type and its checks,
  so the load checks every setting that the host reads itself, and a recipe
  that loaded before can be refused at its next load. This holds for the
  recipe that a host saved in its data directory too: a host whose saved
  recipe holds such a value stops at its next start, with the refusal. A
  release that an update starts on trial stops so before its commit, and
  the next start goes back to the release before, with its data. To
  migrate, give each setting that the refusal names the value that it asks
  for, or, where the refusal says so, leave the key out, which takes the
  default. One refusal names every fault that the schema finds. Newly
  refused:
  - A value of the wrong kind, a word outside a setting's list of words, or
    `null`, at a setting that had no check:
    - at the top level: `description`, `version`, and `mcpServers` itself.
      A list there loaded, and its servers took the names `0`, `1` and so
      on, so give each server a name;
    - in `agent`: `name`, `model`, `formatter`, `prefillUserMessage`,
      `maxTokens`, `anthropicBetas`, `cacheKeepalive.enabled`, and
      `strategy` itself;
    - in `agent.strategy`: `headWindowTokens`, `recentWindowTokens`,
      `compressionModel`, `compressionMaxTokens`, `maxMessageTokens`,
      `overBudgetGraceRatio`,
      `enforceBudget`, `maxSpeculativeL1s`, `positionedRecallPairs`,
      `recallHeaderTemplate`, `targetChunkTokens`, `mergeThreshold`,
      `mergeMaxSourceSpanMessages`, `summaryTargetTokens`,
      `productionBudgetTokens`, `l1BudgetTokens`, `l2BudgetTokens`,
      `l3BudgetTokens`, `toolResultMaxLastN`, `toolUseInputMaxTokens`,
      `adaptiveResolution`, `kvStableReachTokens`, `kvStableQualityGapRatio`,
      `compressionSlackRatio`, `speculativeProduction`, `l1HoldbackChunks`,
      `summaryParticipant`, `summarySystemPrompt`, `summaryUserPrompt`,
      `summaryContextLabel`, `witnessedBeforeSequence`,
      `witnessedInstruction`, `identityReminder` and
      `witnessedIdentityReminder`, under every strategy type, a custom one
      too, so an extension that reads one of these keys gets it only with
      the host's kind. A `null`
      that the host passed on reached context-manager in place of its
      default, so leaving the key out can change what runs: a `null`
      `overBudgetGraceRatio` ran as `0`, where the default is `0.02`;
    - in `agent.refusalHandling`: `retries`, `maxRewinds` and
      `announceHumanTurns`;
    - in an `mcpServers` entry: `env`, `transport`, `token`, `access`,
      `toolPrefix`, `enabledFeatureSets`, `disabledFeatureSets`,
      `reconnect`, `reconnectIntervalMs`, `reconnectMaxIntervalMs`,
      `channelSubscription`, `source.url`, `source.npm`, and
      agent-framework's `protocol`, `tokenTransport`, `credentialRequired`,
      `allowHostCommands`, `enabledCapabilities`, `disabledCapabilities`,
      `scopes` (with each scope's `whitelist` and `blacklist`) and
      `autofetch` (with its `maxBytes` and `maxTotalBytes`);
    - `modules.subagents` itself, and its `defaultModel` and
      `defaultMaxTokens`; `modules.lessons`, `modules.wake`,
      `modules.activity`, `modules.mcplAdmin`, `modules.identity`,
      `modules.fleet`, `modules.webui`, `modules.subscriptionGc`,
      `modules.channelMode` and `sessionNaming`, each itself;
      `modules.retrieval.model` and `maxInjected`;
      `modules.activity.channels`; `modules.mcplAdmin.surface`;
      `modules.identity.home` and `audience`; a fleet child's `dataDir`,
      `env` and `autoRestart`; `modules.webui.port`, `host`,
      `observersSurface`, and `basicAuth.username` and `password`;
      `modules.ttsRelay.botId`, `userId`, `username`,
      `reconnectIntervalMs` and `notifyOnInterruption`;
      `modules.subscriptionGc.defaultLimitChars`, `serverId` and
      `toolPrefix`; `modules.channelMode.serverId`, `toolPrefix`,
      `gcModuleName` and `defaultDebounceMs`; `sessionNaming.examples`.
  - An element of the wrong kind in `agent.anthropicBetas`, in an
    `mcpServers` entry's `channelSubscription`, `enabledFeatureSets`,
    `disabledFeatureSets`, `enabledCapabilities`, `disabledCapabilities`,
    and a scope's `whitelist` and `blacklist`, in
    `modules.activity.channels`, a fleet child's `subscription`,
    `modules.webui.allowedOrigins` and `sessionNaming.examples`, and a
    value of the map form of `agent.strategy.toolResultMaxLastN`.
  - `null`, a list or an object as an element of an `mcpServers` entry's
    `args`, or as a value of its `env` or of a fleet child's `env`.
  - A value of the wrong kind other than `null` at
    `agent.contextBudgetTokens`, `modules.webui.basicAuth` and
    `modules.webui.allowedOrigins`.
  - `agent`, `agent.cacheKeepalive` or an `mcpServers` entry as a list;
    `agent.responses.reasoningEffort` as a list, such as `["low"]`, which
    loaded because its text was a word of the list;
    `agent.strategy.type` as `0`, `""` or `false`, or as a number, `true`,
    a list or an object beside a strategy extension; `agent.refusalHandling`
    as `0` or `""`.
  - A wrong value at a setting that was checked under one branch only:
    `agent.strategy.maxLiveImages`, `imageStripDepthTokens` and
    `maxLiveImageBytes` under a `passthrough` or custom strategy, and
    `codeExecution`'s `yieldMs`, `maxYieldMs`, `scriptLifetimeMs`,
    `maxRunningScripts`, `maxScriptChildren`, `toolCallTimeoutMs`,
    `wakeMinIntervalMs`, `maxWakesPerScript` and `memoryMaxBytes` when
    `enabled` is `false`.
  - `modules.webui.basicAuth` without `username` or `password`, which the
    Web UI refused at its start.
  - An `mcpServers` entry's `id` other than the entry's own name. It
    replaced the server's name where `mcpl-servers.json` has no server of
    the entry's name, and did nothing where it has one. Remove `id`, or
    rename the entry.
  - A number that isn't finite, such as `1e400`, at a setting that takes a
    number.
  - At a setting that had no check, this includes a number or `true`/`false`
    that comes from the environment, such as `"port": "${PORT}"`, since
    substitution gives text.

  Unchanged: a recipe that loads gets the same parsed recipe as before.
  `null` keeps its meaning at `agent.systemPrompt`,
  `agent.contextBudgetTokens`, `agent.refusalHandling` and its
  `autoRewind`, `agent.strategy.type`, and `modules.webui.basicAuth` and
  `allowedOrigins`. A number or `true`/`false` in an `mcpServers` entry's
  `args` or `env`, or in a fleet child's `env`, loads as before.
- **TypeScript callers:** the exported `Recipe*` types now come from the
  schema, and say what the load gives. Where 0.27.1's interfaces said
  otherwise, they changed. For example, `Recipe`'s `agent.cacheTtl` is
  always present, since the load writes it; `RecipeStrategy.type` may be
  absent or `null`; and the types take `null` at
  `agent.contextBudgetTokens`, `agent.refusalHandling`,
  `modules.webui.basicAuth` and `allowedOrigins`, a number or
  `true`/`false` in an `mcpServers` entry's `args` and `env` and a fleet
  child's `env`, `"http"` as an entry's `transport`, the map form of
  `agent.strategy.toolResultMaxLastN`, and `false` at `modules.ttsRelay`.
  `RecipeWake`'s `policies` and `default` are `unknown`, since the load
  doesn't check the wake gate's rules. Code that builds a `Recipe` by hand,
  or reads one of these settings as its old type, may need a change.
  `validateRecipe` returns a new object and leaves its argument as it was,
  where it wrote `agent.systemPrompt` and `agent.cacheTtl` into its
  argument and returned that. `src/tool-lifecycle-config.ts` no longer
  exports `validateToolLifecycle` and `validateToolClassTable`: the schema
  checks a recipe's `toolLifecycle` and `toolClassOverrides`, and
  `parseToolLifecycle` checks a `toolLifecycle` value from elsewhere and
  returns it.
