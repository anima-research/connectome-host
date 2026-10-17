- A launch is refused in a data directory that another of the host's children
  is starting or running in, whether it comes from `fleet--launch`,
  `fleet--restart`, an automatic restart or a host's autoStart. It used to
  start a second child there beside the first, though a child takes its socket
  and pid file in its data directory and unlinks any socket it finds there as
  it starts. An automatic restart refused this way says so in
  `autoRestartStopped`. A launch of a name whose record the host isn't
  attached to is refused the same way while that record says starting or ready
  and its pid is in use, as for a child a host restored at its start before
  the child answered on its socket: it used to start a second copy beside that
  child, or, in another `dataDir`, leave it running untracked. A host
  restoring a record with no usable pid, or one from an earlier boot of the
  machine, marks it `crashed`, as it does one whose pid is gone, so a pid that
  a reboot gave to another process doesn't hold the child's name or directory;
  files the child left in its directory still do, as before. Records keep the
  boot id they launched under, where Linux gives one (`bootId`), and an
  adoption gives a record this boot's; a record without one is placed by its
  start time against the machine's uptime, which a clock stepped by more than
  a minute can misplace. Paths are compared as resolved text, so `data/x/` and
  `data/x` count as one directory, but a path through a symlink doesn't. Files
  another child left in a data directory are said to be that child's, where
  the refusal said the host had no record of a child there.
