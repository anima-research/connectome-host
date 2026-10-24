- An Anthropic error record in llm-calls keeps the full request only for the
  first failure of each kind of error (its type, or for an untyped error its
  name, with its HTTP status when it has one) in a run of failures on its
  cache lineage (model, system and tools); a call's success on that lineage,
  or an hour with no failed call on it, ends the run, and keepalive pokes and
  cancelled calls count for neither.
  The run's later failures of that kind, such as each retry or each turn of
  a rate-limit storm, record the request's size under `rawRequestOmitted`,
  with the hash of the run's copy of that kind as `copySha256` once that
  copy is written, and each complete or
  stream error record with a request carries `requestSha256`. The adapter
  remembers the runs of the 256 lineages whose runs began latest, and a log
  writes at most 64 MiB of such copies at once, refilled at 64 MiB a day:
  the first copy refused for it since the last one written prints one
  `[llm-calls]` stderr line. An anomalous response's copy isn't charged to
  it, and a cancelled call (membrane's `abort`) keeps none. One OAuth 429
  storm had grown a single log to 687MB. A request membrane rejects before sending (such as an unsupported
  prefill) is now kept too, from the error. `LLM_CALLS_FULL_PAYLOADS=1`
  still keeps every copy.
