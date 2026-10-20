// Checks that bun.lock and package-lock.json resolve the stack's packages
// (@animalabs/*) the same way. The README's `bun install` installs a
// checkout from bun.lock, while CI and the publish workflow install with npm
// from package-lock.json, so a change that moves one lockfile and not the
// other would test one tree and hand README installs another. It compares
// what each stack package the host depends on, and each one those depend on
// in turn, resolves to, following Node's lookup through each lockfile's tree
// from the root's dependencies: 'host > @animalabs/agent-framework >
// @animalabs/membrane' is the membrane that agent-framework gets. The two
// trees are walked together, each import looked up from where each lockfile
// places its importer, so what's compared is what each importer gets, not
// where a copy sits, and a chain that comes back to copies it already holds,
// the same one in each lockfile, is compared there and followed no further.
// Other packages aren't compared: a dependency is followed by the name it's
// declared under, so a stack package under an alias outside @animalabs/
// isn't reached, nor is one that only a third-party package depends on. A
// registry version compares as the package and version; a GitHub pin as its
// repository and commit, which bun.lock writes as `github:owner/repo#<sha7>`
// and package-lock.json as a `git+…github.com/owner/repo.git#<sha40>`
// source; and a tarball URL as the URL, except the registry's own tarball of
// the package,
// `https://registry.npmjs.org/<name>/-/<name without its scope>-<version>.tgz`,
// which package-lock.json writes as a registry package's source and which
// compares as its version; a tarball on another host, a mirror's included,
// is a URL. A package neither lockfile installs agrees. Pins of
// another kind on both sides, such as a link, can't be compared, and fail
// saying so; such a pin against one of a known kind differs. CI runs it beside
// `bun install --frozen-lockfile`, which checks bun.lock against
// package.json, as Build & Test's `npm ci` checks package-lock.json on each
// platform. Exits 1 naming each disagreement.
import { readFileSync } from "node:fs";

const SCOPE = "@animalabs/";

/** A lockfile parsed, naming the file when it doesn't parse or has no
 *  `packages` map. bun.lock's trailing commas are removed first. */
function parseLock(file, trailingCommas) {
  const text = readFileSync(file, "utf8");
  let lock;
  try {
    lock = JSON.parse(trailingCommas ? text.replace(/,(\s*[}\]])/g, "$1") : text);
  } catch (error) {
    throw new Error(`${file} doesn't parse: ${error.message}`);
  }
  if (!lock?.packages || typeof lock.packages !== "object") throw new Error(`${file} has no packages map`);
  return lock;
}

const declared = (meta = {}) =>
  Object.keys({ ...meta.dependencies, ...meta.optionalDependencies, ...meta.peerDependencies }).filter((name) =>
    name.startsWith(SCOPE),
  );

const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/;
// The registry the stack's packages are published on.
const REGISTRY = "https://registry.npmjs.org/";

/** What a lockfile pins the package `name` to, from how it writes it: a
 *  registry version, a GitHub repository and commit, a tarball URL, or a
 *  source this check can't compare. The registry's own tarball of the
 *  package, on registry.npmjs.org, is its version; a tarball anywhere else,
 *  a mirror's included, is a URL. */
function pinOf(text, name) {
  const git = /^(?:github:|git\+(?:https|ssh):\/\/(?:git@)?github\.com[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?#([0-9a-f]{7,40})$/i.exec(text);
  if (git) return { kind: "git", repo: git[1].toLowerCase(), commit: git[2].toLowerCase(), text };
  if (VERSION.test(text)) return { kind: "version", name, text };
  if (/^https?:\/\//i.test(text)) {
    const tarball = `${REGISTRY}${name}/-/${name.slice(name.indexOf("/") + 1)}-`;
    const version = text.startsWith(tarball) && text.endsWith(".tgz") ? text.slice(tarball.length, -".tgz".length) : "";
    return VERSION.test(version) ? { kind: "version", name, text: version } : { kind: "url", text };
  }
  return { kind: "other", text };
}

/** bun.lock as a tree: an install path ('a/b' for b nested under a) to the
 *  pin there and the stack packages it declares. Each entry's first element
 *  is `<name>@<version or source>`, and its first object element holds its
 *  dependencies: the third for a registry package, the second for a git or
 *  tarball one. */
function bunTree(lock) {
  const tree = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const meta = entry.slice(1).find((element) => element && typeof element === "object" && !Array.isArray(element));
    // The name is the package's, which an alias's folder isn't.
    const at = entry[0].indexOf("@", 1);
    tree.set(path, { pin: pinOf(entry[0].slice(at + 1), entry[0].slice(0, at)), deps: declared(meta) });
  }
  const root = lock.workspaces?.[""] ?? {};
  return { tree, root: declared({ ...root, dependencies: { ...root.dependencies, ...root.devDependencies } }) };
}

/** package-lock.json as the same tree: 'node_modules/a/node_modules/b' is
 *  'a/b'. Each package pins its `resolved` source: the registry's tarball
 *  for a registry package, a git source or a tarball URL, or a link's
 *  path. Its `version` is its own package.json's, so it pins only an entry
 *  with no `resolved`, as a lock written without registry sources has. An
 *  alias's entry names the package it installs in `name`. */
function npmTree(lock) {
  const tree = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue;
    const at = path.replace(/(^|\/)node_modules\//g, "$1");
    const source = typeof entry.resolved === "string" ? entry.resolved : (entry.version ?? "(no version)");
    tree.set(at, { pin: pinOf(source, entry.name ?? packagesOf(at).at(-1)), deps: declared(entry) });
  }
  const root = lock.packages[""] ?? {};
  return { tree, root: declared({ ...root, dependencies: { ...root.dependencies, ...root.devDependencies } }) };
}

/** An install path's packages: 'a/@s/b' is ['a', '@s/b']. */
function packagesOf(path) {
  const parts = path.split("/");
  const names = [];
  for (let i = 0; i < parts.length; i++) names.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]);
  return names;
}

/** Where `name` resolves from a package installed at `from` ('' for the
 *  root): its own nested copy, then each enclosing package's, then the top. */
function lookup(tree, from, name) {
  const chain = from ? packagesOf(from) : [];
  for (let depth = chain.length; depth >= 0; depth--) {
    const path = [...chain.slice(0, depth), name].join("/");
    if (tree.has(path)) return path;
  }
  return undefined;
}

/** The stack packages one lockfile's copy at `at` declares: the root's at
 *  '', and none where that lockfile has no copy. */
function declaredAt({ tree, root }, at) {
  if (at === undefined) return [];
  return at === "" ? root : tree.get(at).deps;
}

/** Each chain of stack imports from the root, to the pins it resolves to:
 *  bun.lock's, then package-lock.json's. The two trees are walked together,
 *  each import looked up from where each lockfile places its importer, and
 *  only where that importer declares it. A chain that comes back to the
 *  copies it already holds, the same one in each tree, closes a cycle: that
 *  edge is compared, and not followed, since what those copies import is
 *  compared where the chain first reached them. A copy that either lockfile
 *  places elsewhere makes another pair, so it's followed. */
function resolutions(bun, npm) {
  const sides = [bun, npm];
  const out = new Map();
  const visit = (from, chain, held) => {
    for (const name of new Set(sides.flatMap((side, i) => declaredAt(side, from[i])))) {
      const at = sides.map((side, i) => (declaredAt(side, from[i]).includes(name) ? lookup(side.tree, from[i], name) : undefined));
      out.set([...chain, name].join(" > "), sides.map((side, i) => at[i] && side.tree.get(at[i]).pin));
      const copies = JSON.stringify(at);
      if (!held.includes(copies)) visit(at, [...chain, name], [...held, copies]);
    }
  };
  visit(["", ""], ["host"], []);
  return out;
}

/** Whether two pins agree: neither lockfile installs the package, or both
 *  pin the same package at the same registry version, the same tarball URL,
 *  or the same GitHub repository at the same commit, one hash a prefix of
 *  the other. */
function samePin(a, b) {
  if (!a && !b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "git") return a.repo === b.repo && (a.commit.startsWith(b.commit) || b.commit.startsWith(a.commit));
  if (a.kind === "version") return a.name === b.name && a.text === b.text;
  return a.text === b.text;
}

function main() {
  let pins;
  try {
    pins = resolutions(bunTree(parseLock("bun.lock", true)), npmTree(parseLock("package-lock.json", false)));
  } catch (error) {
    console.error(`lockfiles-agree: couldn't read the lockfiles: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const chains = [...pins.keys()].sort();
  if (chains.length === 0) {
    console.error(
      "lockfiles-agree: neither lockfile's root depends on a stack package (@animalabs/*), so there is nothing to " +
        "compare: run it from the host's repository root.",
    );
    return 1;
  }
  // A registry version shows as the version, or as package@version where
  // the chain reaches it under another name, as an alias does.
  const shown = (pin, chain) =>
    !pin ? "none" : pin.kind === "version" && !chain.endsWith(` > ${pin.name}`) ? `${pin.name}@${pin.text}` : pin.text;
  const both = (chain) => `bun.lock ${shown(pins.get(chain)[0], chain)}, package-lock.json ${shown(pins.get(chain)[1], chain)}`;
  // Both of a kind it can't read: a pin of a known kind on either side
  // differs from it, so that pair is reported as differing.
  const unknown = chains.filter((chain) => pins.get(chain).every((pin) => pin?.kind === "other"));
  const differ = chains.filter((chain) => !unknown.includes(chain) && !samePin(...pins.get(chain)));
  if (differ.length === 0 && unknown.length === 0) {
    console.log(
      `bun.lock and package-lock.json resolve the stack's packages the same way: ` +
        `${chains.map((chain) => `${chain} ${shown(pins.get(chain)[0], chain)}`).join("; ")}.`,
    );
    return 0;
  }
  if (differ.length > 0) {
    console.error(
      `The lockfiles resolve the stack's packages differently:\n` +
        differ.map((chain) => `  ${chain}: ${both(chain)}\n`).join("") +
        "Make bun.lock follow package-lock.json: delete bun.lock and run `bun install --lockfile-only`, which builds " +
        "it from package-lock.json, so both pin the same versions.",
    );
  }
  if (unknown.length > 0) {
    console.error(
      `These pins are of a kind this check can't compare (it reads registry versions, GitHub commits and tarball URLs):\n` +
        unknown.map((chain) => `  ${chain}: ${both(chain)}\n`).join("") +
        "Compare them by hand. To keep such a pin, extend pinOf in scripts/lockfiles-agree.mjs so the check reads it.",
    );
  }
  return 1;
}

process.exitCode = main();
