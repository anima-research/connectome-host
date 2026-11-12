- Opt-in Zulip service homes queue independent incidents during successful
  publication instead of suppressing them. Fresh identical observations can
  announce a previously not-dispatched incident after recovery without replaying
  old records; causal publication callbacks remain local-only. Document the
  unqualified long-lived async-context lifecycle risk for connector preflight.
