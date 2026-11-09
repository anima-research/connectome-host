- **Recipe authors and operators:** a recipe whose `modules.fleet`
  `readyTimeoutMs`, `gracefulShutdownMs` or `sigtermEscalationMs` is a
  fraction, or 2147483648 or more, loaded before, and now stops the load,
  naming the field and the value: each must be a whole number of
  milliseconds from 0 to 2147483647, the longest delay a timer keeps.
  Before, Bun and Node set a longer delay to 1 ms, so such a wait ended at
  once, and a fraction ran about as written. Set each to a whole number in
  that range. A start without a recipe argument, in a data directory whose
  saved recipe holds such a value, stops, naming it: start once with the
  corrected recipe as its argument, which saves it in the saved one's
  place. A whole number in that range loads as it did, and
  `socketWaitTimeoutMs` has no upper bound.
