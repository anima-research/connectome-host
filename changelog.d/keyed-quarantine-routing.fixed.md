- Keep finite local keyed-quarantine controls on a separate private UNIX socket
  (`DATA_DIR/q/s`), so inspection/result and pending waivers cannot evict an
  interactive controller or steal its stream. Regular interactive takeover is
  unchanged; control replies stay on their correlated requesting connection.
