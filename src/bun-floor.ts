/**
 * The warning a host prints at start when the Bun running it is below the
 * floor its package.json declares (`engines.bun`). Below that floor the host
 * can fail in ways that don't name Bun, such as an EFAULT from a filesystem
 * call, so the warning names it first. It warns rather than refuses, and
 * nothing else depends on it.
 *
 * The floor is read only in the form the host's package.json gives it,
 * `>=X.Y.Z` (its test checks that it does), and the running version is
 * compared with it by its release numbers. A prerelease, such as a canary,
 * comes before its own release: so a prerelease of the floor's release is
 * below the floor, and one of a later release isn't. Pure, for its test.
 */
const FLOOR = /^\s*>=\s*(\d+)\.(\d+)\.(\d+)\s*$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function bunFloorWarning(engines: unknown, bun: string | undefined, hostVersion: string | undefined): string | null {
  const declared = (engines as { bun?: unknown } | null | undefined)?.bun;
  const floor = typeof declared === 'string' ? FLOOR.exec(declared) : null;
  const running = VERSION.exec(bun ?? '');
  if (!floor || !running) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(running[i]) - Number(floor[i]);
    if (diff > 0) return null;
    if (diff < 0) return warning(floor[0].trim(), bun!, hostVersion);
  }
  return running[4] ? warning(floor[0].trim(), bun!, hostVersion) : null;
}

function warning(floor: string, bun: string, hostVersion: string | undefined): string {
  const host = hostVersion ? `connectome-host ${hostVersion}` : 'connectome-host';
  return `[host] ${host} needs Bun ${floor} (engines.bun in its package.json), and this is Bun ${bun}. ` +
    "Below that it can fail in ways that don't name Bun. Whoever runs this host can upgrade Bun, " +
    'with `bun upgrade` or the package manager that installed it, and start the host again.';
}
