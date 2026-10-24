/**
 * What the registry says of connectome-host's releases, for the update notice
 * and Update (update.ts). One read of the package's full manifest gives every
 * version with its own package.json fields: `deprecated`, `engines.bun`, and
 * `connectomeRelease`, which the cut writes (scripts/release-changelog.ts).
 * The abbreviated manifest npm installs from leaves `connectomeRelease` out,
 * so this asks for the full one.
 *
 * Nothing here is kept between reads: the candidate and the costs are worked
 * out from the manifest each time it's read.
 */
import { EXACT_VERSION, PACKAGE } from './install.js';

/** npm's registry, when `npm_config_registry` doesn't name another. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/** How long a read of the manifest may take. */
export const READ_TIMEOUT_MS = 10_000;

/** One version of the package, as its manifest describes it. */
export interface Release {
  version: string;
  prerelease: boolean;
  /** npm's deprecation message, or null. */
  deprecated: string | null;
  /** `engines.bun` as the release declares it, or null. */
  bunFloor: string | null;
  /** What its cut recorded (`connectomeRelease`): whether anything is
   *  breaking since the last final release before it, and whether an update
   *  from that release writes each resident's prompt cache in full. Null
   *  where it records nothing: a release cut before the field, or a cut
   *  nobody measured the cost of. */
  breaking: boolean | null;
  cacheWrite: boolean | null;
}

/** The registry the host reads, with a closing `/`: the one
 *  `npm_config_registry` names, else npm's own. A registry set only in an
 *  `.npmrc`, such as a scoped `@animalabs:registry=`, isn't read, and the
 *  read carries no token, so a mirror is named in the service's environment
 *  for the notice to read it. */
export function registryOf(env: Record<string, string | undefined> = process.env): string {
  const registry = env.npm_config_registry || DEFAULT_REGISTRY;
  return registry.endsWith('/') ? registry : `${registry}/`;
}

/** The package's versions in a manifest, oldest first. A version that isn't
 *  an exact one, or whose entry isn't an object, is left out. */
export function releasesOf(manifest: unknown): Release[] {
  const versions = (manifest as { versions?: unknown } | null)?.versions;
  if (!versions || typeof versions !== 'object') {
    throw new Error(`The registry's manifest of ${PACKAGE} lists no versions.`);
  }
  const flag = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
  const releases: Release[] = [];
  for (const [version, entry] of Object.entries(versions as Record<string, unknown>)) {
    if (!EXACT_VERSION.test(version) || !entry || typeof entry !== 'object') continue;
    const fields = entry as { deprecated?: unknown; engines?: { bun?: unknown } | null; connectomeRelease?: unknown };
    const recorded = (fields.connectomeRelease && typeof fields.connectomeRelease === 'object'
      ? fields.connectomeRelease : {}) as { breaking?: unknown; cacheWrite?: unknown };
    releases.push({
      version,
      prerelease: version.includes('-'),
      deprecated: typeof fields.deprecated === 'string' && fields.deprecated !== '' ? fields.deprecated : null,
      bunFloor: typeof fields.engines?.bun === 'string' ? fields.engines.bun : null,
      breaking: flag(recorded.breaking),
      cacheWrite: flag(recorded.cacheWrite),
    });
  }
  return releases.sort((a, b) => Bun.semver.order(a.version, b.version));
}

/** `registry` as a message may name it: a user and password in it, which a
 *  URL can carry, are left out, so a log or an answer never shows them. */
export function shownRegistry(registry: string): string {
  let url: URL;
  try {
    url = new URL(registry);
  } catch {
    return registry;
  }
  if (url.username === '' && url.password === '') return registry;
  url.username = '';
  url.password = '';
  return url.toString();
}

/** Read the package's versions from `registry`, within `timeoutMs`. Throws
 *  with the reason when the manifest can't be read, naming the registry as
 *  shownRegistry does, in its own words and in the reason's. */
export async function readReleases(
  registry: string, fetchManifest: typeof fetch = fetch, timeoutMs: number = READ_TIMEOUT_MS,
): Promise<Release[]> {
  const url = `${registry}${PACKAGE.replace('/', '%2f')}`;
  const shown = shownRegistry(registry);
  const reason = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error)).split(registry).join(shown);
  let response: Response;
  try {
    response = await fetchManifest(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`The registry at ${shown} couldn't be read: ${reason(error)}`);
  }
  if (!response.ok) throw new Error(`The registry at ${shown} answered ${response.status} for ${PACKAGE}.`);
  let manifest: unknown;
  try {
    manifest = await response.json();
  } catch (error) {
    throw new Error(`The registry at ${shown} sent a manifest of ${PACKAGE} that isn't JSON: ${reason(error)}`);
  }
  return releasesOf(manifest);
}

/** The release Update offers a host running `running`: the newest final
 *  release after it that isn't deprecated, or null. */
export function candidateOf(releases: readonly Release[], running: string): Release | null {
  const offered = releases.filter((r) => !r.prerelease && r.deprecated === null && Bun.semver.order(r.version, running) > 0);
  return offered.at(-1) ?? null;
}

/** The versions an update from `running` to `to` crosses, each with what it
 *  records: every version after `running`, up to and including `to`,
 *  prereleases and deprecated ones included. A final release's fields cover
 *  the stretch back to the final release before it, so together they cover
 *  the whole update. */
export function rangeOf(releases: readonly Release[], running: string, to: string): Release[] {
  return releases.filter((r) => Bun.semver.order(r.version, running) > 0 && Bun.semver.order(r.version, to) <= 0);
}
