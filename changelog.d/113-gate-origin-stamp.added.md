- Gate telemetry stamps why the turn fired: `x-gate-origin` (heartbeat |
  event | mail | operator | raw reason), `x-gate-channel` and
  `x-gate-counterparty` (adapter-namespaced ids, never content or display
  names) ride the stream lane under the same `GATE_TELEMETRY=1` + base-URL
  gate as the debt stamp; background calls on the complete lane carry debt
  only (#113).
