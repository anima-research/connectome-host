- `messageQuietPeriod`, at the recipe's top level, passes agent-framework's
  message quiet period (`FrameworkConfig.messageQuietPeriod`,
  agent-framework#856) to the framework as written: `{ quietMs, maxWaitMs? }`,
  so a burst of messages starts one turn instead of one per part. A missing
  `quietMs`, a key the option doesn't know, or a value that isn't a finite
  number of ms (0 or more) stops the load, naming it, and so does setting it
  beside `speech.locus: "latest-inbound"`, which agent-framework refuses too. An agent-framework
  without the option ignores the key.
