// Black-box coverage of scripts/lockfiles-agree.mjs: each case runs the real
// script under node, as CI runs it, in a throwaway directory holding the two
// lockfiles it reads.
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/lockfiles-agree.mjs", import.meta.url));

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A tree as both lockfiles describe it: an install path ('a/b' for b
 *  nested under a) to the version there and the packages it depends on,
 *  `optional` and `peer` naming those it declares as optional or peer
 *  dependencies. `git` pins it to a GitHub commit instead,
 *  'owner/repo#<sha40>', and `url` to a tarball URL, as each lockfile writes
 *  one; `source` gives each lockfile's text for a pin of another kind, such
 *  as a link. `alias` names the package an alias's folder installs, and
 *  `noResolved` writes a package-lock.json entry with its version and no
 *  `resolved`. */
type Tree = Record<string, { version: string; deps?: string[]; optional?: string[]; peer?: string[]; git?: string; ssh?: boolean; url?: string; source?: { bun: string; npm: string }; alias?: string; noResolved?: boolean }>;

const ROOT_DEPS = ["@animalabs/agent-framework", "@animalabs/context-manager", "@animalabs/membrane", "discord.js"];
/** An install path's packages: 'a/@s/b' is ['a', '@s/b']. */
function packagesOf(path: string): string[] {
  const parts = path.split("/");
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) names.push(parts[i]!.startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]!);
  return names;
}
const nameOf = (path: string) => packagesOf(path).at(-1)!;
const depsOf = (deps: string[] = []) => Object.fromEntries(deps.map((dep) => [dep, "*"]));
/** A package's dependencies as both lockfiles write them, the optional and
 *  peer ones only when it has some. */
const declaring = ({ deps, optional, peer }: Tree[string]) => ({
  dependencies: depsOf(deps),
  ...(optional ? { optionalDependencies: depsOf(optional) } : {}),
  ...(peer ? { peerDependencies: depsOf(peer) } : {}),
});

/** bun.lock's text, as bun writes it, trailing commas included. */
function bunLock(tree: Tree, rootDeps = ROOT_DEPS, rootDevDeps: string[] = []): string {
  const entries = Object.entries(tree)
    .map(([path, entry]) => {
      const { version, git, url, source, alias } = entry;
      const meta = JSON.stringify(declaring(entry));
      if (git) {
        // As bun writes a GitHub pin: its metadata second, then its id.
        const [repo, sha] = git.split("#") as [string, string];
        return `    "${path}": ["${nameOf(path)}@github:${repo}#${sha.slice(0, 7)}", ${meta}, "${repo.replace("/", "-")}-${sha.slice(0, 7)}", "sha512-zz=="],\n`;
      }
      // As bun writes a tarball URL: its metadata second.
      if (url) return `    "${path}": ["${alias ?? nameOf(path)}@${url}", ${meta}, "sha512-zz=="],\n`;
      // An alias's entry names the package it installs.
      return `    "${path}": ["${alias ?? nameOf(path)}@${source?.bun ?? version}", "", ${meta}, "sha512-zz=="],\n`;
    })
    .join("");
  return `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "zz",\n      "dependencies": ${JSON.stringify(depsOf(rootDeps))},\n      "devDependencies": ${JSON.stringify(depsOf(rootDevDeps))},\n    },\n  },\n  "packages": {\n${entries}  },\n}\n`;
}

/** package-lock.json for the same tree: 'a/b' is node_modules/a/node_modules/b. */
function npmLock(tree: Tree, rootDeps = ROOT_DEPS, rootDevDeps: string[] = []): string {
  const packages: Record<string, unknown> = { "": { name: "zz", dependencies: depsOf(rootDeps), devDependencies: depsOf(rootDevDeps) } };
  for (const [path, entry] of Object.entries(tree)) {
    const { version, git, ssh, url, source, alias, noResolved } = entry;
    // npm writes a registry package's source as the registry's tarball, and a
    // GitHub pin over https, or over ssh as git@github.com; an alias's entry
    // names the package it installs.
    const name = alias ?? nameOf(path);
    const tarball = `https://registry.npmjs.org/${name}/-/${name.slice(name.indexOf("/") + 1)}-${version}.tgz`;
    const resolved = git ? `${ssh ? "git+ssh://git@" : "git+https://"}github.com/${git.replace("#", ".git#")}` : url ?? source?.npm ?? tarball;
    packages[`node_modules/${packagesOf(path).join("/node_modules/")}`] = {
      ...(alias ? { name: alias } : {}),
      version,
      ...(noResolved ? {} : { resolved, integrity: "sha512-zz==" }),
      ...declaring(entry),
    };
  }
  return JSON.stringify({ name: "zz", lockfileVersion: 3, packages }, null, 2);
}

function project(bun: string | undefined, npm: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lockfiles-agree-"));
  made.push(dir);
  if (bun !== undefined) writeFileSync(join(dir, "bun.lock"), bun);
  writeFileSync(join(dir, "package-lock.json"), npm);
  return dir;
}

function check(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [SCRIPT], { cwd: dir, env: { PATH: process.env.PATH ?? "" } }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const STACK: Tree = {
  "@animalabs/agent-framework": { version: "0.22.1", deps: ["@animalabs/context-manager", "@animalabs/membrane"] },
  "@animalabs/membrane": { version: "0.5.87" },
  "@animalabs/context-manager": { version: "0.14.0", deps: ["@animalabs/membrane"] },
  "@animalabs/context-manager/@animalabs/membrane": { version: "0.5.69" },
  "discord.js": { version: "14.25.1" },
};

test("the npm paths the fixture writes are npm's", () => {
  const paths = Object.keys(JSON.parse(npmLock(STACK)).packages);
  assert.deepEqual(paths, [
    "",
    "node_modules/@animalabs/agent-framework",
    "node_modules/@animalabs/membrane",
    "node_modules/@animalabs/context-manager",
    "node_modules/@animalabs/context-manager/node_modules/@animalabs/membrane",
    "node_modules/discord.js",
  ]);
});

test("lockfiles resolving each stack import the same way agree, and say what each resolves to", async () => {
  const result = await check(project(bunLock(STACK), npmLock(STACK)));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    "bun.lock and package-lock.json resolve the stack's packages the same way: " +
      "host > @animalabs/agent-framework 0.22.1; " +
      "host > @animalabs/agent-framework > @animalabs/context-manager 0.14.0; " +
      "host > @animalabs/agent-framework > @animalabs/context-manager > @animalabs/membrane 0.5.69; " +
      "host > @animalabs/agent-framework > @animalabs/membrane 0.5.87; " +
      "host > @animalabs/context-manager 0.14.0; " +
      "host > @animalabs/context-manager > @animalabs/membrane 0.5.69; " +
      "host > @animalabs/membrane 0.5.87.\n",
  );
});

test("a version moved in one lockfile only is named, with each side's version and how to move both", async () => {
  const npm = { ...STACK, "@animalabs/agent-framework": { ...STACK["@animalabs/agent-framework"]!, version: "0.22.2" } };
  const result = await check(project(bunLock(STACK), npmLock(npm)));
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "The lockfiles resolve the stack's packages differently:\n" +
      "  host > @animalabs/agent-framework: bun.lock 0.22.1, package-lock.json 0.22.2\n" +
      "Make bun.lock follow package-lock.json: delete bun.lock and run `bun install --lockfile-only`, which builds " +
      "it from package-lock.json, so both pin the same versions.\n",
  );
});

test("the same versions placed so an importer gets a different one disagree", async () => {
  // npm keeps 0.5.69 at the top and nests 0.5.87 under agent-framework:
  // the same two versions, but the host now imports 0.5.69.
  const npm: Tree = { ...STACK, "@animalabs/membrane": { version: "0.5.69" } };
  delete npm["@animalabs/context-manager/@animalabs/membrane"];
  npm["@animalabs/agent-framework/@animalabs/membrane"] = { version: "0.5.87" };
  const result = await check(project(bunLock(STACK), npmLock(npm)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\n {2}host > @animalabs\/membrane: bun\.lock 0\.5\.87, package-lock\.json 0\.5\.69\n/);
  assert.doesNotMatch(result.stderr, /host > @animalabs\/agent-framework > @animalabs\/membrane:/, "agent-framework gets 0.5.87 in both");
});

test("a copy placed differently that every importer resolves the same way agrees", async () => {
  // A second, nested copy of the same version changes nothing anyone gets.
  const npm: Tree = { ...STACK, "@animalabs/agent-framework/@animalabs/membrane": { version: "0.5.87" } };
  const result = await check(project(bunLock(STACK), npmLock(npm)));
  assert.equal(result.code, 0, result.stderr);
});

test("a stack package one lockfile has and the other lacks is named", async () => {
  const npm: Tree = {
    ...STACK,
    "@animalabs/agent-framework": { version: "0.22.1", deps: ["@animalabs/chronicle", "@animalabs/context-manager", "@animalabs/membrane"] },
    "@animalabs/chronicle": { version: "0.4.0" },
  };
  const result = await check(project(bunLock(STACK), npmLock(npm)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\n {2}host > @animalabs\/agent-framework > @animalabs\/chronicle: bun\.lock none, package-lock\.json 0\.4\.0\n/);
  // bun.lock installs chronicle for the root, but its agent-framework doesn't
  // depend on it, so that import is none there.
  const rootToo = [...ROOT_DEPS, "@animalabs/chronicle"];
  const elsewhere = await check(project(bunLock({ ...STACK, "@animalabs/chronicle": { version: "0.4.0" } }, rootToo), npmLock(npm, rootToo)));
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.stderr, /\n {2}host > @animalabs\/agent-framework > @animalabs\/chronicle: bun\.lock none, package-lock\.json 0\.4\.0\n/);
  // A stack package only bun.lock installs: what it imports is none in
  // package-lock.json, which has no copy to import it.
  const extra: Tree = { ...STACK, "@animalabs/zz-x": { version: "1.0.0", deps: ["@animalabs/membrane"] } };
  const withX = [...ROOT_DEPS, "@animalabs/zz-x"];
  const lacking = await check(project(bunLock(extra, withX), npmLock(STACK, withX)));
  assert.equal(lacking.code, 1);
  assert.deepEqual(lacking.stderr.split("\n").filter((line) => line.startsWith("  ")), [
    "  host > @animalabs/zz-x: bun.lock 1.0.0, package-lock.json none",
    "  host > @animalabs/zz-x > @animalabs/membrane: bun.lock 0.5.87, package-lock.json none",
  ]);
});

test("the root's devDependencies are followed too, since both installs take them", async () => {
  const bun: Tree = { ...STACK, "@animalabs/chronicle": { version: "0.4.0" } };
  const npm: Tree = { ...STACK, "@animalabs/chronicle": { version: "0.4.1" } };
  const result = await check(project(bunLock(bun, ROOT_DEPS, ["@animalabs/chronicle"]), npmLock(npm, ROOT_DEPS, ["@animalabs/chronicle"])));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\n {2}host > @animalabs\/chronicle: bun\.lock 0\.4\.0, package-lock\.json 0\.4\.1\n/);
});

test("other packages may differ", async () => {
  const result = await check(project(bunLock(STACK), npmLock({ ...STACK, "discord.js": { version: "14.26.0" } })));
  assert.equal(result.code, 0, result.stderr);
});

test("a missing, damaged or shapeless lockfile fails, naming it", async () => {
  const missing = await check(project(undefined, npmLock(STACK)));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^lockfiles-agree: couldn't read the lockfiles: .*bun\.lock/);
  const damaged = await check(project(bunLock(STACK), "{ not json"));
  assert.equal(damaged.code, 1);
  assert.match(damaged.stderr, /^lockfiles-agree: couldn't read the lockfiles: package-lock\.json doesn't parse: /);
  const shapeless = await check(project(`{ "lockfileVersion": 1, }`, npmLock(STACK)));
  assert.equal(shapeless.code, 1);
  assert.equal(shapeless.stderr, "lockfiles-agree: couldn't read the lockfiles: bun.lock has no packages map\n");
});

// From main's lockfiles at 065b034 (Sep 10 to 14), which pinned membrane to a
// commit: bun.lock writes `github:antra-tess/membrane#18a86e9`, with its
// metadata second, and package-lock.json the git source and membrane's own
// version, 0.5.84.
const MEMBRANE_PIN = "antra-tess/membrane#18a86e9eda277378acd982b07c7fe7c187721119";
const PINNED: Tree = {
  ...STACK,
  "@animalabs/membrane": { version: "0.5.84", git: MEMBRANE_PIN },
  "@animalabs/context-manager/@animalabs/membrane": { version: "0.5.84", git: MEMBRANE_PIN },
};

test("a stack package pinned to a GitHub commit compares as its repository and commit", async () => {
  const result = await check(project(bunLock(PINNED), npmLock(PINNED)));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /host > @animalabs\/membrane github:antra-tess\/membrane#18a86e9[;.]/);
  assert.match(result.stdout, /host > @animalabs\/context-manager > @animalabs\/membrane github:antra-tess\/membrane#18a86e9[;.]/);
});

test("a git-pinned stack package's own stack dependencies are followed, from where bun keeps its metadata", async () => {
  // agent-framework pinned to a commit, its metadata in bun's second slot,
  // depending on a membrane only bun.lock moves.
  const pinned: Tree = { ...STACK, "@animalabs/agent-framework": { version: "0.22.1", deps: ["@animalabs/membrane"], git: "anima-research/agent-framework#1234567890abcdef1234567890abcdef12345678" } };
  const bumped: Tree = { ...pinned, "@animalabs/agent-framework/@animalabs/membrane": { version: "0.5.88" } };
  const result = await check(project(bunLock(bumped), npmLock(pinned)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /host > @animalabs\/agent-framework > @animalabs\/membrane: bun\.lock 0\.5\.88, package-lock\.json 0\.5\.87/);
});

test("another commit, or another repository, disagrees, naming each side's pin", async () => {
  const other: Tree = { ...PINNED, "@animalabs/membrane": { version: "0.5.84", git: "antra-tess/membrane#0123456789abcdef0123456789abcdef01234567" } };
  const result = await check(project(bunLock(other), npmLock(PINNED)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /host > @animalabs\/membrane: bun\.lock github:antra-tess\/membrane#0123456, package-lock\.json git\+https:\/\/github\.com\/antra-tess\/membrane\.git#18a86e9eda277378acd982b07c7fe7c187721119/);
  const fork: Tree = { ...PINNED, "@animalabs/membrane": { version: "0.5.84", git: "someone/membrane#18a86e9eda277378acd982b07c7fe7c187721119" } };
  const forked = await check(project(bunLock(fork), npmLock(PINNED)));
  assert.equal(forked.code, 1);
  assert.match(forked.stderr, /host > @animalabs\/membrane: bun\.lock github:someone\/membrane#18a86e9, package-lock\.json git\+https:\/\/github\.com\/antra-tess\/membrane\.git#18a86e9eda277378acd982b07c7fe7c187721119/);
});

test("a pin of a kind the check can't compare fails, saying so, without the relock remedy", async () => {
  const linked: Tree = { ...STACK, "@animalabs/membrane": { version: "0.5.87", source: { bun: "file:../membrane", npm: "../membrane" } } };
  const result = await check(project(bunLock(linked), npmLock(linked)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /can't compare/);
  assert.match(result.stderr, /host > @animalabs\/membrane: bun\.lock file:\.\.\/membrane, package-lock\.json \.\.\/membrane/);
  assert.doesNotMatch(result.stderr, /delete bun\.lock/);
});

test("npm's ssh form of a GitHub pin, and a repository named in another case, compare as the same pin", async () => {
  const ssh: Tree = { ...PINNED, "@animalabs/membrane": { version: "0.5.84", git: MEMBRANE_PIN, ssh: true } };
  const viaSsh = await check(project(bunLock(PINNED), npmLock(ssh)));
  assert.equal(viaSsh.code, 0, viaSsh.stderr);
  const cased: Tree = { ...PINNED, "@animalabs/membrane": { version: "0.5.84", git: "Antra-Tess/Membrane#18a86e9eda277378acd982b07c7fe7c187721119" } };
  const inCase = await check(project(bunLock(cased), npmLock(PINNED)));
  assert.equal(inCase.code, 0, inCase.stderr);
});

// As each lockfile writes a dependency on a tarball URL (npm 11.17.0 and
// bun 1.4.3, October 17): package-lock.json the URL as its source, beside
// the package's own version, and bun.lock `<name>@<url>`, its metadata
// second. For the registry's own tarball, package-lock.json writes what it
// writes for a version range.
const REGISTRY_TARBALL = "https://registry.npmjs.org/@animalabs/chronicle/-/chronicle-0.4.0.tgz";
const CODELOAD = "https://codeload.github.com/antra-tess/membrane/tar.gz/18a86e9eda277378acd982b07c7fe7c187721119";

test("a dependency on the registry's own tarball compares as its version", async () => {
  const bun: Tree = { ...STACK, "@animalabs/chronicle": { version: "0.4.0", url: REGISTRY_TARBALL } };
  const npm: Tree = { ...STACK, "@animalabs/chronicle": { version: "0.4.0" } };
  const result = await check(project(bunLock(bun, ROOT_DEPS, ["@animalabs/chronicle"]), npmLock(npm, ROOT_DEPS, ["@animalabs/chronicle"])));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /host > @animalabs\/chronicle 0\.4\.0[;.]/);
});

test("another tarball URL compares as the URL: the same on both sides agrees, another differs, naming both", async () => {
  const pinned: Tree = { ...STACK, "@animalabs/membrane": { version: "0.5.84", url: CODELOAD } };
  const same = await check(project(bunLock(pinned), npmLock(pinned)));
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /host > @animalabs\/membrane https:\/\/codeload\.github\.com\/antra-tess\/membrane\/tar\.gz\/18a86e9eda277378acd982b07c7fe7c187721119[;.]/);
  const moved: Tree = { ...pinned, "@animalabs/membrane": { version: "0.5.84", url: CODELOAD.replace("18a86e9", "0123456") } };
  const result = await check(project(bunLock(moved), npmLock(pinned)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\n {2}host > @animalabs\/membrane: bun\.lock https:\/\/codeload\.github\.com\/antra-tess\/membrane\/tar\.gz\/0123456\w+, package-lock\.json https:\/\/codeload\.github\.com\/antra-tess\/membrane\/tar\.gz\/18a86e9\w+\n/);
});

test("a registry version against another tarball URL differs, though the tarball's package has that version", async () => {
  // Another host, the registry's layout on another host or under a mirror's
  // path, another package's tarball on the registry, a file that isn't a
  // tarball, and one whose name doesn't end in a version: each is a URL, not
  // the registry's version.
  for (const url of [
    "https://example.invalid/some-other-chronicle.tgz",
    "https://example.invalid/@animalabs/chronicle/-/chronicle-0.4.0.tgz",
    "https://mirror.example/npm/@animalabs/chronicle/-/chronicle-0.4.0.tgz",
    "https://registry.npmjs.org/@animalabs/membrane/-/membrane-0.4.0.tgz",
    "https://registry.npmjs.org/@animalabs/chronicle/-/chronicle-0.4.0.zip",
    "https://registry.npmjs.org/@animalabs/chronicle/-/chronicle-latest.tgz",
  ]) {
    const bun: Tree = { ...STACK, "@animalabs/chronicle": { version: "0.4.0" } };
    const npm: Tree = { ...STACK, "@animalabs/chronicle": { version: "0.4.0", url } };
    const result = await check(project(bunLock(bun, ROOT_DEPS, ["@animalabs/chronicle"]), npmLock(npm, ROOT_DEPS, ["@animalabs/chronicle"])));
    assert.equal(result.code, 1, url);
    assert.ok(result.stderr.includes(`\n  host > @animalabs/chronicle: bun.lock 0.4.0, package-lock.json ${url}\n`), result.stderr);
  }
});

test("an alias of a stack package compares as the package and version, and a package-lock.json entry with no resolved as its version", async () => {
  const aliased: Tree = { ...STACK, "@animalabs/chronicle-x": { version: "0.4.0", alias: "@animalabs/chronicle" } };
  const roots = [...ROOT_DEPS, "@animalabs/chronicle-x"];
  const alias = await check(project(bunLock(aliased, roots), npmLock(aliased, roots)));
  assert.equal(alias.code, 0, alias.stderr);
  assert.match(alias.stdout, /host > @animalabs\/chronicle-x @animalabs\/chronicle@0\.4\.0[;.]/);
  // An alias of the registry's own tarball reads as its version on both sides.
  const tarballAlias: Tree = { ...STACK, "@animalabs/chronicle-x": { version: "0.4.0", alias: "@animalabs/chronicle", url: REGISTRY_TARBALL } };
  const aliasedTarball = await check(project(bunLock(tarballAlias, roots), npmLock(tarballAlias, roots)));
  assert.equal(aliasedTarball.code, 0, aliasedTarball.stderr);
  assert.match(aliasedTarball.stdout, /host > @animalabs\/chronicle-x @animalabs\/chronicle@0\.4\.0[;.]/);
  // npm writes an alias's entry with its name and version and no resolved
  // when the lock is written without registry sources.
  const unresolvedAlias: Tree = { ...STACK, "@animalabs/chronicle-x": { version: "0.4.0", alias: "@animalabs/chronicle", noResolved: true } };
  const aliasedVersion = await check(project(bunLock(aliased, roots), npmLock(unresolvedAlias, roots)));
  assert.equal(aliasedVersion.code, 0, aliasedVersion.stderr);
  assert.match(aliasedVersion.stdout, /host > @animalabs\/chronicle-x @animalabs\/chronicle@0\.4\.0[;.]/);
  // The same alias for another package at the same version differs.
  const other: Tree = { ...STACK, "@animalabs/chronicle-x": { version: "0.4.0", alias: "@animalabs/membrane" } };
  const swapped = await check(project(bunLock(aliased, roots), npmLock(other, roots)));
  assert.equal(swapped.code, 1);
  assert.ok(
    swapped.stderr.includes("\n  host > @animalabs/chronicle-x: bun.lock @animalabs/chronicle@0.4.0, package-lock.json @animalabs/membrane@0.4.0\n"),
    swapped.stderr,
  );
  const bare: Tree = { ...STACK, "@animalabs/membrane": { version: "0.5.87", noResolved: true } };
  const unresolved = await check(project(bunLock(STACK), npmLock(bare)));
  assert.equal(unresolved.code, 0, unresolved.stderr);
  assert.match(unresolved.stdout, /host > @animalabs\/membrane 0\.5\.87[;.]/);
});

test("the two lockfiles are walked together: a chain that comes back to the copies it holds in both is compared there and followed no further, and a copy either places elsewhere is followed, what it imports compared", async () => {
  // zz-a depends on zz-b and zz-c, and zz-b on zz-a: with no copy of its
  // own, zz-b's zz-a is the top one, which the chain already holds.
  const cycle: Tree = {
    ...STACK,
    "@animalabs/zz-a": { version: "1.0.1", deps: ["@animalabs/zz-b", "@animalabs/zz-c"] },
    "@animalabs/zz-b": { version: "2.0.0", deps: ["@animalabs/zz-a"] },
    "@animalabs/zz-c": { version: "1.0.0" },
  };
  const roots = [...ROOT_DEPS, "@animalabs/zz-a"];
  const same = await check(project(bunLock(cycle, roots), npmLock(cycle, roots)));
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /host > @animalabs\/zz-a > @animalabs\/zz-b > @animalabs\/zz-a 1\.0\.1[;.]/);
  assert.doesNotMatch(same.stdout, /@animalabs\/zz-b > @animalabs\/zz-a > @animalabs\/zz-b/);
  // A copy of zz-a at the same version, nested under zz-b in one lockfile
  // only, is another copy there, so the chain follows it once and compares
  // what it imports on both sides. With a zz-c of its own, at another
  // version than the top one, it imports another zz-c than the top zz-a
  // does, and that edge is named.
  const placed = (zzc?: string): Tree => ({
    ...cycle,
    "@animalabs/zz-b/@animalabs/zz-a": { version: "1.0.1", deps: ["@animalabs/zz-b", "@animalabs/zz-c"] },
    ...(zzc ? { "@animalabs/zz-b/@animalabs/zz-a/@animalabs/zz-c": { version: zzc } } : {}),
  });
  for (const [bun, npm] of [[placed(), cycle], [cycle, placed()]] as const) {
    const elsewhere = await check(project(bunLock(bun, roots), npmLock(npm, roots)));
    assert.equal(elsewhere.code, 0, elsewhere.stderr);
    assert.match(elsewhere.stdout, /host > @animalabs\/zz-a > @animalabs\/zz-b > @animalabs\/zz-a > @animalabs\/zz-b 2\.0\.0[;.]/);
    assert.doesNotMatch(elsewhere.stdout, /@animalabs\/zz-b > @animalabs\/zz-a > @animalabs\/zz-b > /);
  }
  const bunNests = await check(project(bunLock(placed("2.0.0"), roots), npmLock(cycle, roots)));
  assert.equal(bunNests.code, 1);
  assert.match(bunNests.stderr, /\n {2}host > @animalabs\/zz-a > @animalabs\/zz-b > @animalabs\/zz-a > @animalabs\/zz-c: bun\.lock 2\.0\.0, package-lock\.json 1\.0\.0\n/);
  const npmNests = await check(project(bunLock(cycle, roots), npmLock(placed("2.0.0"), roots)));
  assert.equal(npmNests.code, 1);
  assert.match(npmNests.stderr, /\n {2}host > @animalabs\/zz-a > @animalabs\/zz-b > @animalabs\/zz-a > @animalabs\/zz-c: bun\.lock 1\.0\.0, package-lock\.json 2\.0\.0\n/);
  // A copy of zz-a at another version, nested under zz-b in both, is
  // followed: its own stack dependencies are compared, and its edge back to
  // zz-b, the top copy the chain holds in both, closes the cycle.
  const nested = (version: string, more: Tree = {}): Tree => ({
    ...cycle,
    "@animalabs/zz-b/@animalabs/zz-a": { version, deps: ["@animalabs/zz-b", "@animalabs/zz-c"] },
    ...more,
  });
  const followed = await check(project(bunLock(nested("1.0.0"), roots), npmLock(nested("1.0.0"), roots)));
  assert.equal(followed.code, 0, followed.stderr);
  assert.match(followed.stdout, /host > @animalabs\/zz-a > @animalabs\/zz-b > @animalabs\/zz-a > @animalabs\/zz-b 2\.0\.0[;.]/);
  assert.match(followed.stdout, /host > @animalabs\/zz-a > @animalabs\/zz-b > @animalabs\/zz-a > @animalabs\/zz-c 1\.0\.0[;.]/);
  assert.doesNotMatch(followed.stdout, /@animalabs\/zz-a > @animalabs\/zz-b > @animalabs\/zz-a > @animalabs\/zz-b > /);
  const moved = await check(project(bunLock(nested("1.0.0"), roots), npmLock(nested("0.9.0"), roots)));
  assert.equal(moved.code, 1);
  assert.match(moved.stderr, /\n {2}host > @animalabs\/zz-a > @animalabs\/zz-b > @animalabs\/zz-a: bun\.lock 1\.0\.0, package-lock\.json 0\.9\.0\n/);
  // The edge that closes the cycle in bun.lock reaches another version in
  // package-lock.json: that edge is named.
  const oneSided = await check(project(bunLock(cycle, roots), npmLock(nested("0.9.0"), roots)));
  assert.equal(oneSided.code, 1);
  assert.match(oneSided.stderr, /\n {2}host > @animalabs\/zz-a > @animalabs\/zz-b > @animalabs\/zz-a: bun\.lock 1\.0\.1, package-lock\.json 0\.9\.0\n/);
  const beneath = await check(project(
    bunLock(nested("1.0.0"), roots),
    npmLock(nested("1.0.0", { "@animalabs/zz-b/@animalabs/zz-a/@animalabs/zz-c": { version: "2.0.0" } }), roots),
  ));
  assert.equal(beneath.code, 1);
  assert.match(beneath.stderr, /\n {2}host > @animalabs\/zz-a > @animalabs\/zz-b > @animalabs\/zz-a > @animalabs\/zz-c: bun\.lock 1\.0\.0, package-lock\.json 2\.0\.0\n/);
});

test("optional and peer dependencies are followed too, and a stack package that neither lockfile installs agrees, shown as none", async () => {
  // context-manager declares two optional stack packages, one installed and
  // one that installs on neither side, as one for another platform wouldn't,
  // and a peer.
  const declares = (version: string): Tree => ({
    ...STACK,
    "@animalabs/context-manager": {
      version: "0.14.0",
      deps: ["@animalabs/membrane"],
      optional: ["@animalabs/zz-optional", "@animalabs/zz-absent"],
      peer: ["@animalabs/zz-peer"],
    },
    "@animalabs/zz-optional": { version },
    "@animalabs/zz-peer": { version },
  });
  const result = await check(project(bunLock(declares("1.0.0")), npmLock(declares("1.0.0"))));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /host > @animalabs\/context-manager > @animalabs\/zz-absent none[;.]/);
  assert.match(result.stdout, /host > @animalabs\/context-manager > @animalabs\/zz-optional 1\.0\.0[;.]/);
  assert.match(result.stdout, /host > @animalabs\/context-manager > @animalabs\/zz-peer 1\.0\.0[;.]/);
  const moved = await check(project(bunLock(declares("1.0.0")), npmLock(declares("1.1.0"))));
  assert.equal(moved.code, 1);
  assert.match(moved.stderr, /\n {2}host > @animalabs\/context-manager > @animalabs\/zz-optional: bun\.lock 1\.0\.0, package-lock\.json 1\.1\.0\n/);
  assert.match(moved.stderr, /\n {2}host > @animalabs\/context-manager > @animalabs\/zz-peer: bun\.lock 1\.0\.0, package-lock\.json 1\.1\.0\n/);
});

test("a pin of another kind against a version differs, with the relock remedy, and isn't called incomparable", async () => {
  const linked: Tree = { ...STACK, "@animalabs/membrane": { version: "0.5.87", source: { bun: "0.5.87", npm: "../membrane" } } };
  const result = await check(project(bunLock(linked), npmLock(linked)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /resolve the stack's packages differently:\n/);
  // agent-framework's chain to membrane differs the same way, and sorts first.
  assert.match(result.stderr, /^ {2}host > @animalabs\/membrane: bun\.lock 0\.5\.87, package-lock\.json \.\.\/membrane$/m);
  assert.match(result.stderr, /^ {2}host > @animalabs\/agent-framework > @animalabs\/membrane: bun\.lock 0\.5\.87, package-lock\.json \.\.\/membrane$/m);
  assert.match(result.stderr, /delete bun\.lock/);
  assert.doesNotMatch(result.stderr, /can't compare/);
});

test("lockfiles whose roots depend on no stack package fail: there's nothing to compare", async () => {
  const result = await check(project(bunLock(STACK, ["discord.js"]), npmLock(STACK, ["discord.js"])));
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "lockfiles-agree: neither lockfile's root depends on a stack package (@animalabs/*), so there is nothing to compare: run it from the host's repository root.\n",
  );
});
