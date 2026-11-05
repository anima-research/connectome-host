import { readFileSync } from 'node:fs';
import { bunFloorWarning } from './bun-floor.js';

export const HOST_PACKAGE_JSON = new URL('../package.json', import.meta.url);

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

export const bunFloorNotice = checkBunFloor();
