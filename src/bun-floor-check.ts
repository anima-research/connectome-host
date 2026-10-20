/**
 * Warns at start when this Bun is below the host's floor (see bun-floor.ts).
 * src/index.ts imports it first, so the warning prints before the modules
 * imported after it run, whose failures on an older Bun may not name Bun.
 * The TUI shows the same line in its own view (`bunFloorNotice`), since its
 * alternate screen hides what was printed before it.
 */
import { readFileSync } from 'node:fs';
import { bunFloorWarning } from './bun-floor.js';

/** The host's own package.json, which declares the floor. */
export const HOST_PACKAGE_JSON = new URL('../package.json', import.meta.url);

/** The warning for the package.json at `pkgUrl` and the Bun running this,
 *  printed with `warn`; null when there's none. A package.json that can't be
 *  read changes nothing about starting. */
export function checkBunFloor(pkgUrl: URL = HOST_PACKAGE_JSON, warn: (line: string) => void = console.warn): string | null {
  let pkg: { version?: unknown; engines?: unknown } | null;
  try {
    pkg = JSON.parse(readFileSync(pkgUrl, 'utf-8'));
  } catch {
    return null;
  }
  const notice = bunFloorWarning(pkg?.engines, process.versions.bun, typeof pkg?.version === 'string' ? pkg.version : undefined);
  if (notice) warn(notice);
  return notice;
}

/** The warning this start printed, for the TUI to show; null when none. */
export const bunFloorNotice = checkBunFloor();
