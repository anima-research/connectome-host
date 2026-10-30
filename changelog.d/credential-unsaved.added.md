- When the host can't write a refreshed or pasted Anthropic credential back
  to its `ANTHROPIC_OAUTH_CREDENTIALS_FILE`, it now raises the
  `credential-unsaved` ops alert, naming the file and the error, and keeps
  using the new credential. The alert stands beside the credential's state,
  which it leaves as it was. While it stands, `/auth status` says so and
  `/auth recheck` writes the credential to the file again; the next write
  that succeeds clears it. The notices module tells it in status channels.
