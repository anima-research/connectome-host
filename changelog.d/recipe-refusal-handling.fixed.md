- A recipe whose `agent.refusalHandling` is `true`, a number other than 0, a
  non-empty string or an array, or whose `refusalHandling.autoRewind` is set
  to something other than a boolean or `null`, is now refused when it loads,
  naming the key. Since agent-framework 0.22.3 such a recipe loaded and then
  stopped the host at start-up with agent-framework's own error. Leaving it
  out, `false`, `null`, `0` and `""` still mean no refusal handling.
