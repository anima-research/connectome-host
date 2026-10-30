- When the self-update refuses an installed host's start, before any agent
  starts, the host now gives the refusal as the plain sentence it is, in its
  log. That covers an install none or several of whose releases hold the
  host, or whose releases can't be read; a `current` that is missing or
  couldn't be read, moved or synced; a release started where `current` names
  another and no switch or Go back is under way; a trial that can't tell
  which places its fallback puts back, can't open its active session's
  store, or can't open every other store it would open after its commit;
  and a trial whose MCPL server didn't connect. When a release on trial
  refuses after its trial's log has started, `/update` also shows the
  refusal among the trial's last lines once it has gone back; a refusal
  about the install's releases, or about a `current` already missing or
  unreadable when the start begins, comes before that log starts. Before,
  each came as `Fatal error:` with a stack, which read as a crash.
- Installing a release where the copy's label is missing and the journal
  records no copy taken no longer says the label "was lost".
