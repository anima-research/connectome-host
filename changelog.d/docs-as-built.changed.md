- docs: documentation brought in line with what the host does today. The
  README opens with what it is used for (long-lived residents, continued
  conversations, fleets, knowledge mining) and its reference sections were
  corrected against the code — MCP servers are recipe opt-in, `"webui": true`
  alone refuses to start off loopback, no Rust toolchain is needed, and the
  full provider, environment-variable, slash-command, key-binding and recipe
  tables. `ARCHITECTURE.md` is rewritten as-built. The original architecture
  document and the headless-fleet, unified-tree and locus-routing plans move
  verbatim to [`docs/history/`](docs/history/README.md), with notes on what
  became of each; the living headless/fleet protocol they contained is now
  [`docs/fleet-protocol.md`](docs/fleet-protocol.md). New
  [`docs/README.md`](docs/README.md) indexes every guide. Drift fixed across
  the memory and gating guides (adaptive resolution, L1…L8, what the
  compression pass actually sees, `gate_status`, `wake_add_rule`), the
  deployment, dev-environment, WebUI and debug-API guides, and the recipe
  setup guides (the TUI's chat ↔ fleet views, the `[y/N/d]` quit prompt).
  Source comments and the no-subfleets error now point at the new locations.
