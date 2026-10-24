- `agent.homeChannel` in the recipe: speech from turns with no triggering
  channel (heartbeats, timers) goes to this channel instead of whichever
  channel last received a message, so a check-in no longer lands in an
  unrelated (possibly public) channel. Turns triggered from a channel still
  reply there. Needs an agent-framework with the `homeChannel` option; older
  frameworks ignore it.
