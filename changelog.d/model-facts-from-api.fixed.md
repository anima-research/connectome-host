- **A model's window and maximum output are read from Anthropic's Models API
  at start**, once per model the recipe names (the resident's, the subagents'
  default, retrieval's), and kept in `data/model-facts.json`. The recipe loads
  against the host's own table alone; then the kept facts are loaded, this
  start's read replaces what it could read, and the fit is decided once, on
  those: a recipe whose budget passes the model's window is refused at that
  start, and where the refusal rests on the kept file rather than this
  start's read, the line names the file, the read's date and `MODEL_FACTS=off`
  as the way to start without it. So the `[fit]` check and the default
  context budget know a model released after this host from its first start,
  where before they knew only the models in the host's own table
  (`model-limits.ts`, with the dates someone read the docs in its comment),
  and a new model ran with no known window until a row landed (#693). The
  table stands where the API can't be read: no credential, a gateway that
  doesn't serve it, a model it doesn't know, or no network, each said once;
  a kept entry is checked as the API's answer is, so a damaged file doesn't
  stand in for the table. The read also keeps what the API says of the
  model's effort levels, thinking types and lifecycle; a model past `active`
  is said at start with its retirement date. `MODEL_FACTS=off` turns the load
  and the read off; behind a gateway (`ANTHROPIC_BASE_URL`), which may not
  serve the endpoint, the read runs only with `MODEL_FACTS=on`.
