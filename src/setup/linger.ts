import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function lingerOf(user: string, root = '/'): boolean | null {
  // sd_booted's test, and the file loginctl enable-linger makes: `loginctl show-user` fails for a user with no
  // session and no linger rather than answering no.
  if (!existsSync(join(root, 'run', 'systemd', 'system'))) return null;
  return existsSync(join(root, 'var', 'lib', 'systemd', 'linger', user));
}
