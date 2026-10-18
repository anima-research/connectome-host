- llm-calls error records no longer carry the full raw request for
  rate-limit, overload/server, network, timeout, abort and auth errors,
  only a size note. Those errors repeat across retries, and one OAuth 429
  storm grew a single log to 687MB. Request-shape errors
  (`invalid_request`, `context_length`, `unsupported`) and non-membrane
  errors keep the request, and `LLM_CALLS_FULL_PAYLOADS=1` keeps it for all.
