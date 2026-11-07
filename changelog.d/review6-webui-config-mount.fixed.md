- The Web UI's surgery dialog answers once the Web UI has written the
  `_config` mount after a rollback or a suppression, and says when that
  write failed (`surgery-result`'s `mountError`), as it does after one
  that failed and left the store on the branch it made. It answered
  before the write and dropped its failure, so the dialog said Done while
  the gate's files could still be the previous branch's. The failure is
  logged as `[webui] _config refresh failed: …`.
- In the Web UI, a command's answer that says the `_config` mount wasn't
  written (a `/checkout`, or a `/restore` to a branch's head, whose write
  of it failed, a failed rollback that left the store on its new branch) is followed by what the
  Web UI's own write of the mount, which follows every move there, then
  did: "The Web UI has since written the _config mount from <branch>." or
  "The Web UI's refresh of the _config mount failed too: …". The other
  modes write no mount after a move, so the answer holds there.
