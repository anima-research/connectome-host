- Claude Fable 5.2 and Claude Mythos 5.2 (`claude-fable-5-2`, `claude-mythos-5-2`):
  the operator ledger and `priceCall` price them at $8 input, $40 output, $10
  and $16 for 5-minute and 1-hour cache writes, and $0.20 for a cache read per
  million tokens, where each was priced as Fable 5 or Mythos 5 ($10/$50, reads
  at 0.1x), under pricing version `anthropic-public-2026-11-09`, and
  kv-unified's standard block prices their cache reads at 0.025x of input,
  where it took 0.1x; the start's fit check reads their 1,000,000-token window
  and 128,000 tokens of output; Fable 5.2's thinking is
  recorded as binding, taking the drop control, thinking with no config and
  showing its window, and Mythos 5.2's as Mythos 5.1's; and through
  Anthropic's API, on both an 'omitted' thinking display is sent as
  'updates', so the notes they write between tool calls are kept as text.
  That those notes come back as thinking blocks rests, on Fable 5.2, on
  Anthropic's prompting guide for it and the API taking 'updates'; on Mythos
  5.2, untried, on the same guide, which says its patterns are specific to
  both models, and on the release notes, which say it offers the same
  capabilities.
  - **Cache:** `agent_settings`' `reasoning_display` description no longer
    names models. It is part of the `agent_settings` tool, and tools come
    first in a request, so where a request carries that tool in its tool
    list, whatever its model, on any provider whose prompt cache covers the
    tools, the first such request after upgrading writes its whole cached
    prompt again, once. An agent already on Fable 5.2 or Mythos 5.2 with
    kv-unified's standard block can pick another layout once after the
    upgrade, which rewrites its prompt cache once.
