/**
 * The abbreviated manifest npm installs from leaves `connectomeRelease` out,
 * so this asks for the full one.
 */
import { EXACT_VERSION, PACKAGE } from './install.js';

/** npm's registry, when `npm_config_registry` doesn't name another. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

export const READ_TIMEOUT_MS = 10_000;

export interface Release {
  version: string;
  prerelease: boolean;
  deprecated: string | null;
  bunFloor: string | null;
  breaking: boolean | null;
  cacheWrite: boolean | null;
}

/** The registry the host reads: the one `npm_config_registry` names, else
 *  npm's own. A registry set only in an `.npmrc`, such as a scoped
 *  `@animalabs:registry=`, isn't read, and the read carries no token, so
 *  a mirror is named in the service's environment for the notice to read
 *  it. */
export function registryOf(env: Record<string, string | undefined> = process.env): string {
  const registry = env.npm_config_registry || DEFAULT_REGISTRY;
  return registry.endsWith('/') ? registry : `${registry}/`;
}

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

export function candidateOf(releases: readonly Release[], running: string): Release | null {
  const offered = releases.filter((r) => !r.prerelease && r.deprecated === null && Bun.semver.order(r.version, running) > 0);
  return offered.at(-1) ?? null;
}

export function rangeOf(releases: readonly Release[], running: string, to: string): Release[] {
  return releases.filter((r) => Bun.semver.order(r.version, running) > 0 && Bun.semver.order(r.version, to) <= 0);
}
