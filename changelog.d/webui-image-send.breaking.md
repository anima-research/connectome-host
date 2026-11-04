- **Web UI clients that read an image's data from a `trace` or
  `child-event` frame:** the `data` of each `image` or `generated_image`
  block in those frames is now a note of its length, so a `trace` no longer
  carries the framework's `TraceEvent` verbatim, nor a `child-event` the
  child's `WireEvent` as it arrived. A stored message's image is at
  `/media/<ref>`, by the `ref` its transcript entry carries (with `?scope=`
  for a fleet child's). An image the host keeps nowhere a client can fetch
  it, such as a `tool:result_dropped` trace's result or an incoming event's
  image that no module stores, now reaches a client by no route.
  Unchanged: transcript frames and their refs, and the Context document,
  which reads `/debug/context`.
