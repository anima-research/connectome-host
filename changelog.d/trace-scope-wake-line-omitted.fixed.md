- A Web UI observer with the `ops` scope gets the `gate:wake-line-omitted`
  trace that agent-framework adds after 0.26.0, as it gets the gate's other
  traces. Without an entry in the observers' trace table, it would reach
  full clients only.
