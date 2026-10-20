- **Recipe authors and operators:** the host defaults for omitted memory fields changed.
  - An omitted `agent.strategy.foldingStrategy` (autobiographical or frontdesk, adaptive
    resolution on) is now `kv-unified`, with the host's standard `kvUnified` block, not
    `kv-stable`. A resident whose store was built under kv-stable switches solver on its
    first boot after the upgrade (a layout change: one full prompt-cache rewrite). To keep it
    on kv-stable, set `"foldingStrategy": "kv-stable"` before upgrading.
  - An omitted `agent.contextBudgetTokens` is now 300k (was the context manager's 100k).
    The default assumes a 1M-window model: a recipe on a 200k-window model must set its own
    budget, or every reply is rejected for exceeding the window.
  - An omitted `agent.strategy.recentWindowTokens` is now 40% of the budget (120k at the
    300k default), was 30k.
  - An omitted `agent.maxStreamTokens` is now 320k when the budget is omitted too. With an
    explicit budget it stays 150k.
  - Selecting `kv-unified` without a `kvUnified` block now gets the standard block instead of
    failing at load. The block's cache prices are matched to what the provider bills, as
    multiples of base input. Claude: writes 2 on the 1-hour cache, 1.25 on the 5-minute cache
    and on Bedrock; reads 0.1, except 0.05 on Claude Opus 5.5 and 0.025 on Claude Fable 5.1 /
    Mythos 5.1. Claude Sonnet 5.5's reads are billed at 0.05 but take 0.1 here. OpenAI:
    writes 1.25 on the API for the GPT-5.6 and GPT-6 families, else 1, and 1 on Codex; reads
    by model (0.1 on most, 0.05 on GPT-6.1 Sol). With prompt caching
    off (`agent.promptCaching: false`, or a Bedrock model without caching) both are 1. A
    written block must still be complete.
  - The built-in default recipe (no recipe argument and no saved recipe, or `--no-recipe`)
    now has an empty system prompt and takes all of these defaults.
  - Unchanged: recipes that set these fields explicitly, and complete `kvUnified` blocks,
    which pass through as written. The context manager still always receives a complete
    block.
- `agent.strategy.kvUnified.hysteresisCertificate` is now part of the recipe type, and a
  non-boolean value fails at recipe load. It was already passed through.
- The context curve panel, when it can't read the live budget, falls back to the recipe's
  budget or the 300k default, not 200k.
