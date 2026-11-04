- A long message pushed live to the Web UI shows as one entry, as a reload
  shows it, rather than one row per stored shard (#345).
- An older-history page the Web UI asked for before a change of branch no
  longer lands in the new branch's transcript, and a reconnect no longer
  leaves a load in progress until its request times out.
