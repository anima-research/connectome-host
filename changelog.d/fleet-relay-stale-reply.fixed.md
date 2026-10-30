- `fleet--relay` no longer passes on a reply from a running child its
  host can't reach. Replies the child made while the host had no
  connection to it never reached the host, so the reply it held might not
  be the child's latest. It now refuses, saying why, until the host has
  seen the child's process end, and then passes that reply on. Each time
  the host connects to a child again, it forgets the child's last reply.
