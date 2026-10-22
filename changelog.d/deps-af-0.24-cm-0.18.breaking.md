- **Operators:** connectome-host now requires `@animalabs/agent-framework`
  ^0.24.0 (was ^0.23.1), `@animalabs/context-manager` ^0.18.0 (was ^0.14.0)
  and `@animalabs/membrane` ^0.6.0 (was ^0.5.87), and installs one copy of
  each. The changes operators meet, in brief; agent-framework 0.24.0's notes
  give each in full, and list what reaches a host from the context-manager
  and membrane releases in between:
  - **`code_execution` runs JavaScript, not Python,** in a QuickJS sandbox on
    the host's own runtime, reaching nothing but its agent's tools, and the
    host no longer needs a Python interpreter. A recipe whose
    `codeExecution` is on and sets one of the Python runner's settings
    (`pythonPath`, `env`, `inheritEnv`, `scriptTimeoutMs`, `idleReclaimMs`,
    `maxScriptTimeoutMs`, `backgroundMaxLifetimeMs`, `maxBackgroundScripts`)
    now stops loading, with an error naming what to set instead, such as
    `yieldMs` for `scriptTimeoutMs`. The recipe type is now the framework's
    `CodeExecutionConfig`, and the runner's numeric settings (`yieldMs`,
    `maxYieldMs`, `scriptLifetimeMs`, `maxRunningScripts`,
    `maxScriptChildren`, `toolCallTimeoutMs`, `wakeMinIntervalMs`,
    `maxWakesPerScript`, `memoryMaxBytes`) must be whole numbers of 0 or
    more. A prompt that teaches an agent Python scripts needs rewriting.
  - **Subagents' usage is one line:** every ephemeral agent counts in one
    shared `ephemeral agents` entry, so `/usage` and the Web UI's per-agent
    cost show one line for all subagents instead of one each.
  - **Live surgery places no Discord awareness marks.** A Web UI rollback or
    suppression used to react 💤 on every Discord message it removed. The
    framework now places marks only when the operator chooses them, and this
    host doesn't offer that choice yet.
  - **Workspace paths written with `//` or a trailing `/`** are read in one
    spelling, so an entry the store's history holds under another spelling
    is outside its mount.
  - **kv-unified:** a recipe's kv-unified strategy now prices ages in bands,
    ranks latent merge demand jointly and solves with the subtree engine,
    unless the recipe opts out (`policy.ageBandSteps: 0`,
    `latentDemandMode: "individual"`, `engine: "dag"`), and takes the
    hysteresis certificate unless `hysteresisCertificate` is `false`. The
    first compile after the upgrade can lay the context out differently,
    which rewrites the prompt cache once. A merge no longer groups the
    summaries on either side of a message no chunk owns, which made every
    later compile throw `CanonicalForestError`.
  - **Prompt cache:** membrane 0.6.0's notes for media it doesn't send, and
    stored content that context-manager 0.16.0 now reads mended, can each
    miss the cache once, at the first request after the upgrade.
  - Going back to connectome-host 0.11.x installs agent-framework 0.23.x and
    context-manager 0.14.x from its lockfile. Back the store up before
    upgrading.
