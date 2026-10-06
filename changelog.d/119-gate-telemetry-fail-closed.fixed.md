- **`GATE_TELEMETRY` now parses fail-closed** (#119). The env-flag parser
  treated every non-empty string except `0`/`false` as ON, so `off`, `no` and
  ordinary typos ENABLED the telemetry headers — with a configured base URL,
  the exact data-boundary leak the double gate exists to close. Only an
  allowlisted affirmative (`1` or `true`, trimmed, case-insensitive) enables
  it now; recognized negatives stay silent and any other value warns once,
  naming the accepted forms. The same fail-open parser copy guarding
  `LLM_CALLS_FULL_PAYLOADS` in the llm-calls logger is hardened identically.
