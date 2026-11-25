- **Recipe authors:** the recipe's type and its checks now come from one
  schema. The load now checks every setting that the host itself reads. Some
  recipes that loaded before are now refused. A refusal lists each fault
  that the schema finds.
  - **A saved recipe:** the host keeps a copy of its recipe in its data
    directory. When you start the host without naming a recipe, it resumes
    that copy. If the load refuses the copy, the host stops. A service unit
    names a recipe file. A start that names a recipe file loads that file,
    and then saves it as the new copy.
  - **An update on trial:** the trial loads each recipe that a start would
    load. A refusal stops the trial before its commit. The next start then
    goes back to the earlier release and its data.
  - **To migrate:** give each named setting the value that the refusal asks
    for. Where the refusal says so, you can also leave the key out.
  - **Servers in `mcpl-servers.json`:** the file gives a server's values.
    The server's entry in `mcpServers` can replace them. Before, a `null` in
    the entry replaced the file's value for that key. Now, if you leave the
    key out, the server takes the file's value. To run without the file's
    value, write the value that you want in the recipe, or change
    `mcpl-servers.json`.

  Newly refused:
  - **A wrong value at a setting that had no check:** a value of the wrong
    kind, a word outside the setting's list of words, or `null`. These
    settings had no check:
    - At the top level: `description`, `version`, and `mcpServers` itself.
      Before, the load took a list there, and named its servers `0`, `1` and
      so on. Give each server a name.
    - In `agent`: `name`, `model`, `formatter`, `prefillUserMessage`,
      `maxTokens`, `anthropicBetas`, `cacheKeepalive.enabled`, and
      `strategy` itself.
    - In `agent.strategy`, under every strategy type, a custom one too:
      `headWindowTokens`, `recentWindowTokens`, `compressionModel`,
      `compressionMaxTokens`, `maxMessageTokens`, `overBudgetGraceRatio`,
      `enforceBudget`, `maxSpeculativeL1s`, `positionedRecallPairs`,
      `recallHeaderTemplate`, `targetChunkTokens`, `mergeThreshold`,
      `mergeMaxSourceSpanMessages`, `summaryTargetTokens`,
      `productionBudgetTokens`, `l1BudgetTokens`, `l2BudgetTokens`,
      `l3BudgetTokens`, `toolResultMaxLastN`, `toolUseInputMaxTokens`,
      `adaptiveResolution`, `kvStableReachTokens`,
      `kvStableQualityGapRatio`, `compressionSlackRatio`,
      `speculativeProduction`, `l1HoldbackChunks`, `summaryParticipant`,
      `summarySystemPrompt`, `summaryUserPrompt`, `summaryContextLabel`,
      `witnessedBeforeSequence`, `witnessedInstruction`, `identityReminder`
      and `witnessedIdentityReminder`. So an extension can count on the
      host's kind of value at these keys. The host passed some of these
      `null`s on to context-manager, where a `null` replaced the default. So
      leaving such a key out can change what runs. A `null`
      `overBudgetGraceRatio` ran as `0`, and its default is `0.02`.
    - In `agent.refusalHandling`: `retries`, `maxRewinds` and
      `announceHumanTurns`.
    - In an `mcpServers` entry: `env`, `transport`, `token`, `access`,
      `toolPrefix`, `enabledFeatureSets`, `disabledFeatureSets`,
      `reconnect`, `reconnectIntervalMs`, `reconnectMaxIntervalMs`,
      `channelSubscription`, `source.url` and `source.npm`. Also
      agent-framework's `protocol`, `tokenTransport`, `credentialRequired`,
      `allowHostCommands`, `enabledCapabilities`, `disabledCapabilities`,
      `scopes` (with each scope's `whitelist` and `blacklist`) and
      `autofetch` (with its `maxBytes` and `maxTotalBytes`).
    - Each of these itself: `modules.subagents`, `modules.lessons`,
      `modules.wake`, `modules.activity`, `modules.mcplAdmin`,
      `modules.identity`, `modules.fleet`, `modules.webui`,
      `modules.subscriptionGc`, `modules.channelMode` and `sessionNaming`.
    - Within them: `modules.subagents.defaultModel` and `defaultMaxTokens`;
      `modules.retrieval.model` and `maxInjected`;
      `modules.activity.channels`; `modules.mcplAdmin.surface`;
      `modules.identity.home` and `audience`; a fleet child's `dataDir`,
      `env` and `autoRestart`; `modules.webui.port`, `host`,
      `observersSurface`, and `basicAuth.username` and `password`;
      `modules.ttsRelay.botId`, `userId`, `username`, `reconnectIntervalMs`
      and `notifyOnInterruption`;
      `modules.subscriptionGc.defaultLimitChars`, `serverId` and
      `toolPrefix`; `modules.channelMode.serverId`, `toolPrefix`,
      `gcModuleName` and `defaultDebounceMs`; `sessionNaming.examples`.
  - **An element of the wrong kind** in a list: `agent.anthropicBetas`; an
    `mcpServers` entry's `channelSubscription`, `enabledFeatureSets`,
    `disabledFeatureSets`, `enabledCapabilities` and `disabledCapabilities`;
    a scope's `whitelist` and `blacklist`; `modules.activity.channels`; a
    fleet child's `subscription`; `modules.webui.allowedOrigins`; and
    `sessionNaming.examples`. Also a value of the wrong kind in the map form
    of `agent.strategy.toolResultMaxLastN`.
  - **`null`, a list or an object** as an element of an `mcpServers` entry's
    `args`, or as a value of its `env` or of a fleet child's `env`.
  - **A value of the wrong kind other than `null`** at
    `agent.contextBudgetTokens`, `modules.webui.basicAuth` and
    `modules.webui.allowedOrigins`.
  - **A list in place of an object** at `agent`, `agent.cacheKeepalive` or
    an `mcpServers` entry.
  - **`agent.responses.reasoningEffort` as a list,** such as `["low"]`. It
    loaded before, because its text matched one of the setting's words.
  - **`agent.strategy.type` as `0`, `""` or `false`.** With a strategy
    extension, the load also refuses a number, `true`, a list or an object
    there.
  - **`agent.refusalHandling` as `0` or `""`.**
  - **A wrong value at a setting that went unchecked in some cases.** These
    are `agent.strategy.maxLiveImages`, `imageStripDepthTokens` and
    `maxLiveImageBytes` under a `passthrough` or custom strategy. They are
    also `codeExecution`'s `yieldMs`, `maxYieldMs`, `scriptLifetimeMs`,
    `maxRunningScripts`, `maxScriptChildren`, `toolCallTimeoutMs`,
    `wakeMinIntervalMs`, `maxWakesPerScript` and `memoryMaxBytes` when
    `enabled` is `false`.
  - **`modules.webui.basicAuth` without `username` or `password`.** The Web
    UI refused it at its start.
  - **An `mcpServers` entry's `id` other than the entry's own name.**
    Before, the `id` replaced the server's name. It did nothing if
    `mcpl-servers.json` had a server of the entry's name. Remove `id`, or
    rename the entry.
  - **A number that isn't finite,** such as `1e400`, at a setting that takes
    a number.
  - **A number or `true`/`false` from the environment** at a setting that
    had no check, such as `"port": "${PORT}"`. Substitution gives text, and
    these settings now check the kind of value.

  Unchanged: a recipe that loads gets the same parsed recipe as before, with
  one exception. A saved recipe of the older form has no `$unresolved` key.
  Such a recipe now loses each key named `__proto__`, such as a server of
  that name in `mcpServers`. A recipe file already lost such a key at
  substitution. `null` keeps its meaning at `agent.systemPrompt`,
  `agent.contextBudgetTokens`, `agent.refusalHandling` and its `autoRewind`,
  `agent.strategy.type`, and `modules.webui.basicAuth` and `allowedOrigins`.
  A number or `true`/`false` still loads in an `mcpServers` entry's `args`
  and `env`, and in a fleet child's `env`.
- **TypeScript callers:** the exported `Recipe*` types now come from the
  schema, and they say what the load gives. Where the interfaces of 0.27.1
  said otherwise, the types changed. For example:
  - `Recipe`'s `agent.cacheTtl` is always present, since the load writes it.
  - `RecipeStrategy.type` may be absent or `null`.
  - The types take `null` at `agent.contextBudgetTokens`,
    `agent.refusalHandling`, `modules.webui.basicAuth` and `allowedOrigins`.
    They take a number or `true`/`false` among a server's `args`, and in the
    `env` of a server or a fleet child. They also take `"http"` as an
    entry's `transport`, the map form of
    `agent.strategy.toolResultMaxLastN`, and `false` at
    `agent.refusalHandling` and `modules.ttsRelay`.
  - `RecipeWake`'s `policies` and `default` are `unknown`, since the load
    doesn't check the wake gate's rules.

  Code that builds a `Recipe` by hand may need a change. Code that reads one
  of these settings as its old type may need a change too. `validateRecipe`
  now returns a new object and leaves its argument as it was. Before, it
  wrote `agent.systemPrompt` and `agent.cacheTtl` into its argument and
  returned the argument. `src/tool-lifecycle-config.ts` no longer exports
  `validateToolLifecycle` and `validateToolClassTable`. The schema checks a
  recipe's `toolLifecycle` and `toolClassOverrides`, and
  `parseToolLifecycle` checks a `toolLifecycle` value from elsewhere and
  returns it.
