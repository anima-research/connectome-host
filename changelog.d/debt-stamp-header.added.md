- Gate-bound Anthropic calls carry an `x-gate-debt-chunks` header with the
  live compression-debt pending-chunk count (membrane `dynamicHeaders`,
  antra-tess/membrane#65) — the gateway records it per ledger row and strips
  it before the vendor. Double-gated on `GATE_TELEMETRY=1` AND a configured
  `ANTHROPIC_BASE_URL`, so the stamp can never reach a vendor endpoint;
  unreadable state sends no header rather than a guess (#109).
