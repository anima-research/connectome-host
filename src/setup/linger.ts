import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Whether systemd keeps `user`'s services running while they're logged out: null where the system isn't running
 *  systemd, true when `/var/lib/systemd/linger/<user>` exists, and false otherwise. */
export function lingerOf(user: string, root = '/'): boolean | null {
  // sd_booted's test, and the file loginctl enable-linger makes: `loginctl show-user` fails for a user with no
  // session and no linger rather than answering no.
  if (!existsSync(join(root, 'run', 'systemd', 'system'))) return null;
  return existsSync(join(root, 'var', 'lib', 'systemd', 'linger', user));
}
