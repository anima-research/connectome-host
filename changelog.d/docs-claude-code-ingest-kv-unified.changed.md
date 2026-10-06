- docs: new [`docs/claude-code-ingest.md`](docs/claude-code-ingest.md) — continuing a
  Claude Code session transcript as a resident (active-branch walk, verbatim signed
  thinking, `tool_result` storage shape, verify-on-a-copy, and a `reasoning_extraction`
  refusal triage + mitigation section). `AGENT-ONBOARDING.md`: recipe skeleton updated to
  the tuned production values (300k/100k/32k, chunk 3000, merge 6, recall 40k, tool-prose
  fallback, `refusalHandling`), new §5b on `kv-stable` vs `kv-unified` with the reference
  kv-unified configuration and its preconditions, and new gotchas §11.8 (topology audit /
  open-mutates-store), §11.9 (`reasoning_extraction`), §11.10 (model-bound signed thinking).
