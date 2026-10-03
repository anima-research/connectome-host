- **`modules.subagents`, `modules.retrieval` and `modules.instructions` are
  deprecated and not recommended.** All three deliver content through context
  injection (`gatherContext`), which is deprecated
  (anima-research/agent-framework#171): injected blocks are per-compile
  overlays that are never stored and are re-anchored on every compile, so they
  break prompt-cache prefixes across activations. They still work unchanged;
  the host now logs one `[deprecated]` line per enabled module at startup
  (`deprecatedModuleNotices()` in `recipe.ts`), and the recipe types, module
  headers, README and retrieval-traces doc carry the notice. Instead: put
  stable operating instructions in `agent.systemPrompt`; use the lesson tools
  (`modules.lessons`) rather than automatic retrieval.
