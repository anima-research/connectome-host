- **`walkCap` on a recipe's workspace mount:** the most entries one walk of
  the mount takes, agent-framework's 5000 unless set, passed to the
  framework as given. A sync that reaches it reports the rest as incomplete,
  and the next sync of the same scope resumes after the last entry it took;
  agent-framework makes that place durable with the store's next sync, so if
  the machine goes down before then, a sync can start again from an earlier
  place. A value that
  isn't a whole number from 1 to 9007199254740991
  (`Number.MAX_SAFE_INTEGER`) stops the recipe loading, with an error naming
  the mount.
