// Black-box coverage of scripts/release-bump.mjs. Most cases run the script
// under node as npm's preversion hook runs it, with npm_old_version and
// npm_new_version set, in a throwaway directory holding its own changelog.
// The last cases run npm itself with this repository's preversion entry, and
// with the version hook (release-changelog.ts, under bun) beside it, so the
// wiring that makes `npm version` refuse before it writes anything is tested
// too.
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/release-bump.mjs", import.meta.url));
const HOLDS = fileURLToPath(new URL("../scripts/release-holds.mjs", import.meta.url));
const FOLD = fileURLToPath(new URL("../scripts/release-changelog.ts", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const UNRELEASED = "# Changelog\n\n## Unreleased\n\n## 0.22.1 — 2026-10-14\n\n### Breaking\n\n- An old breaking entry, already released.\n";

/** A throwaway project: package.json at `version`, a CHANGELOG.md, and
 *  changelog.d/ holding `fragments` (name to body). */
function project(version: string, fragments: Record<string, string> = {}, changelog = UNRELEASED): string {
  const dir = mkdtempSync(join(tmpdir(), "release-bump-"));
  made.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version, repository: "github:owner/repo" }),
  );
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  mkdirSync(join(dir, "changelog.d"));
  writeFileSync(join(dir, "changelog.d", "README.md"), "Fragments go here.\n");
  for (const [name, body] of Object.entries(fragments)) writeFileSync(join(dir, "changelog.d", name), body);
  return dir;
}

/** A changelog whose Unreleased section holds `title` with `body` under it. */
const filed = (title: string, body: string) =>
  `# Changelog\n\n## Unreleased\n\n### ${title}\n\n${body}\n## 0.22.1 — 2026-10-14\n\n### Fixed\n\n- A fix.\n`;

function exec(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env: { PATH: process.env.PATH ?? "", ...env } }, (error, _stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stderr });
    });
  });
}

/** The script as preversion runs it, going from `from` to `to`. */
const bump = (dir: string, from: string, to: string) =>
  exec("node", [SCRIPT], dir, { npm_old_version: from, npm_new_version: to });

const BREAKING = { "300-retry-hint.breaking.md": "- **Hosts:** a breaking change.\n" };
const goesAhead = { code: 0, stderr: "" };

test("a pending breaking fragment refuses a patch, naming it and the bump that would do", async () => {
  const result = await bump(project("0.22.1", BREAKING), "0.22.1", "0.22.2");
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "Release refused: a breaking change is pending, and 0.22.1 to 0.22.2 stays in 0.22.x, which a dependent's caret range on 0.22.x takes.\n" +
      "  changelog.d/300-retry-hint.breaking.md\n" +
      "Before 1.0, a breaking change goes out in a new minor version, which a dependent's range doesn't take until the dependent raises it. " +
      "Run npm version minor (0.22.1 to 0.23.0). Nothing has been bumped or written.\n",
  );
});

test("a new minor, or 1.0, takes a pending breaking fragment", async () => {
  const dir = project("0.22.1", BREAKING);
  assert.deepEqual(await bump(dir, "0.22.1", "0.23.0"), goesAhead);
  assert.deepEqual(await bump(dir, "0.22.1", "1.0.0"), goesAhead);
});

test("with no breaking entry pending, a patch goes ahead", async () => {
  const dir = project("0.22.1", { "301-fix.fixed.md": "- A fix.\n", "302-new.added.md": "- A feature.\n" });
  assert.deepEqual(await bump(dir, "0.22.1", "0.22.2"), goesAhead);
});

test("anything filed under a Breaking subsection of Unreleased counts, whatever its form or its title's case", async () => {
  const bodies = [
    "- **Module authors:** a bullet.\n",
    "* a star bullet.\n",
    "  - an indented bullet.\n",
    "+ a plus bullet.\n",
    "1. A numbered item.\n",
    "Prose, with no list at all.\n",
    "| a | table |\n|---|---|\n",
  ];
  for (const body of bodies) {
    const result = await bump(project("0.22.1", {}, filed("Breaking", body)), "0.22.1", "0.22.2");
    assert.equal(result.code, 1, `refused for ${JSON.stringify(body)}`);
    assert.match(result.stderr, /\n {2}CHANGELOG\.md: '### Breaking' under '## Unreleased'\n/);
  }
  for (const title of ["Breaking (module authors only)", "BREAKING", "breaking changes"]) {
    const result = await bump(project("0.22.1", {}, filed(title, "- A change.\n")), "0.22.1", "0.22.2");
    assert.equal(result.code, 1, `refused under '### ${title}'`);
    assert.ok(result.stderr.includes(`  CHANGELOG.md: '### ${title}' under '## Unreleased'\n`), result.stderr);
  }
});

test("an empty Breaking heading, or a Breaking section already released, isn't pending", async () => {
  assert.deepEqual(await bump(project("0.22.1", {}, filed("Breaking", "")), "0.22.1", "0.22.2"), goesAhead);
  assert.deepEqual(await bump(project("0.22.1"), "0.22.1", "0.22.2"), goesAhead);
});

test("each pending breaking entry is named once", async () => {
  const changelog = "## Unreleased\n\n### Breaking\n\n- **Hosts:** filed directly.\n- **Module authors:** and another.\n";
  const result = await bump(
    project("0.22.1", { ...BREAKING, "303-another.breaking.md": "- **Module authors:** another.\n" }, changelog),
    "0.22.1",
    "0.22.2",
  );
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /\n {2}changelog\.d\/300-retry-hint\.breaking\.md\n {2}changelog\.d\/303-another\.breaking\.md\n {2}CHANGELOG\.md: '### Breaking' under '## Unreleased'\nBefore 1\.0/,
  );
});

test("from 1.0, a breaking change needs a new major", async () => {
  const dir = project("1.4.2", BREAKING);
  const minor = await bump(dir, "1.4.2", "1.5.0");
  assert.equal(minor.code, 1);
  assert.match(minor.stderr, /1\.4\.2 to 1\.5\.0 stays in 1\.x, which a dependent's caret range on 1\.x takes\./);
  assert.match(minor.stderr, /A breaking change goes out in a new major version, /);
  assert.match(minor.stderr, /Run npm version major \(1\.4\.2 to 2\.0\.0\)\./);
  assert.deepEqual(await bump(dir, "1.4.2", "2.0.0"), goesAhead);
});

test("a prerelease counts as the release it leads to: a prepatch can't carry a breaking change, a preminor can", async () => {
  const dir = project("0.22.1", BREAKING);
  const prepatch = await bump(dir, "0.22.1", "0.22.2-0");
  assert.equal(prepatch.code, 1);
  assert.match(
    prepatch.stderr,
    /0\.22\.1 to 0\.22\.2-0 stays in 0\.22\.x: no caret range takes a prerelease, but the version hook would fold the pending entries into its own section, where the next version's check wouldn't see them\./,
  );
  assert.deepEqual(await bump(dir, "0.22.1", "0.23.0-0"), goesAhead);
  assert.deepEqual(await bump(dir, "1.4.2", "2.0.0-0"), goesAhead);
});

test("finishing a prerelease: a new line's goes ahead, a patch's is refused as a patch", async () => {
  const dir = project("0.23.0-1", BREAKING);
  // 0.23 and 2.x have no release yet, so no dependent's range holds them.
  assert.deepEqual(await bump(dir, "0.23.0-1", "0.23.0"), goesAhead);
  assert.deepEqual(await bump(dir, "0.23.0-1", "0.23.1"), goesAhead);
  assert.deepEqual(await bump(dir, "2.0.0-0", "2.0.0"), goesAhead);
  // 0.22.2-0 leads to a patch of 0.22, and 1.4.0-1 to a minor of 1.x.
  const patch = await bump(dir, "0.22.2-0", "0.22.2");
  assert.equal(patch.code, 1);
  assert.match(patch.stderr, /0\.22\.2-0 to 0\.22\.2 stays in 0\.22\.x, which a dependent's caret range on 0\.22\.x takes\./);
  assert.match(patch.stderr, /Run npm version minor \(0\.22\.2-0 to 0\.23\.0\)\./);
  const minor = await bump(dir, "1.4.0-1", "1.4.0");
  assert.equal(minor.code, 1);
  assert.match(minor.stderr, /Run npm version major \(1\.4\.0-1 to 2\.0\.0\)\./);
});

test("^0.0.z takes nothing but itself, so any bump goes ahead", async () => {
  assert.deepEqual(await bump(project("0.0.3", BREAKING), "0.0.3", "0.0.4"), goesAhead);
});

test("a version below the current line is refused too, since a dependent's range may still hold it", async () => {
  const dir = project("0.22.1", BREAKING);
  const older = await bump(dir, "0.22.1", "0.21.9");
  assert.equal(older.code, 1);
  assert.match(older.stderr, /0\.22\.1 to 0\.21\.9 goes back to 0\.21\.x, which a dependent's caret range may still hold\./);
  // From a prerelease that opens 0.23: 0.22.2 is above every 0.22 release so far.
  const back = await bump(dir, "0.23.0-0", "0.22.2");
  assert.equal(back.code, 1);
  assert.match(back.stderr, /0\.23\.0-0 to 0\.22\.2 goes back to 0\.22\.x/);
  assert.match(back.stderr, /Run npm version minor \(0\.23\.0-0 to 0\.23\.0\)\./);
  // Lower but in the current line: still the line a dependent's range takes.
  const lower = await bump(dir, "0.22.5", "0.22.3");
  assert.equal(lower.code, 1);
  assert.match(lower.stderr, /0\.22\.5 to 0\.22\.3 stays in 0\.22\.x, which a dependent's caret range on 0\.22\.x takes\./);
  assert.equal((await bump(dir, "1.4.2", "1.3.0")).code, 1);
});

test("a final release that opened its line has reached it: a patch or minor of it is refused", async () => {
  const dir = project("0.23.0", BREAKING);
  const patch = await bump(dir, "0.23.0", "0.23.1");
  assert.equal(patch.code, 1);
  assert.match(patch.stderr, /0\.23\.0 to 0\.23\.1 stays in 0\.23\.x/);
  const minor = await bump(dir, "2.0.0", "2.1.0");
  assert.equal(minor.code, 1);
  assert.match(minor.stderr, /2\.0\.0 to 2\.1\.0 stays in 2\.x/);
});

test("entries under other subsections of Unreleased aren't pending", async () => {
  const changelog = "## Unreleased\n\n### Fixed\n\n- A fix.\n\n### Changed (module authors)\n\nProse about a change.\n";
  assert.deepEqual(await bump(project("0.22.1", {}, changelog), "0.22.1", "0.22.2"), goesAhead);
});

test("run outside npm version, it goes ahead with nothing pending, and refuses, saying why, with something pending", async () => {
  assert.deepEqual(await exec("node", [SCRIPT], project("0.22.1"), {}), goesAhead);
  const result = await exec("node", [SCRIPT], project("0.22.1", BREAKING), {});
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "release-bump: a breaking change is pending, and this check needs npm version's old and new versions to decide " +
      "(npm_old_version=unset, npm_new_version=unset): run it through npm version.\n",
  );
  const half = await exec("node", [SCRIPT], project("0.22.1", BREAKING), { npm_old_version: "0.22.1" });
  assert.equal(half.code, 1);
  assert.match(half.stderr, /\(npm_old_version=0\.22\.1, npm_new_version=unset\)/);
});

/** A local stand-in for GitHub's issues endpoint with no hold open, for the
 *  hold check that preversion also runs. */
async function noHolds(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A throwaway project whose preversion is this repository's own, and whose
 *  version hook is its changelog fold, with the scripts beside them. (The
 *  repository's version hook also stages the fold with git, which this
 *  project, with no repository, leaves out.) */
function wiredProject(fragments: Record<string, string>): string {
  const scripts = (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { scripts: Record<string, string> }).scripts;
  const dir = project("0.22.1", fragments);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ ...pkg, scripts: { preversion: scripts.preversion, version: "bun scripts/release-changelog.ts" } }),
  );
  mkdirSync(join(dir, "scripts"));
  copyFileSync(SCRIPT, join(dir, "scripts", "release-bump.mjs"));
  copyFileSync(HOLDS, join(dir, "scripts", "release-holds.mjs"));
  copyFileSync(FOLD, join(dir, "scripts", "release-changelog.ts"));
  writeFileSync(join(dir, ".npmrc"), "");
  return dir;
}

/** npm, kept to the throwaway directory and the stand-in for GitHub. */
function npm(dir: string, args: string[], api: string) {
  return exec("npm", args, dir, {
    HOME: dir,
    npm_config_cache: join(dir, ".npm-cache"),
    npm_config_userconfig: join(dir, ".npmrc"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    GITHUB_API_URL: api,
  });
}

const versionOf = (dir: string) => (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
const fragmentPending = (dir: string) => existsSync(join(dir, "changelog.d", "300-retry-hint.breaking.md"));

test("this repository's preversion stops npm version patch, prepatch and prerelease before anything is written", async () => {
  const gh = await noHolds();
  try {
    for (const level of ["patch", "prepatch", "prerelease"]) {
      const dir = wiredProject(BREAKING);
      const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
      const result = await npm(dir, ["version", level, "--no-git-tag-version"], gh.url);
      assert.notEqual(result.code, 0, level);
      assert.match(result.stderr, /Release refused: a breaking change is pending, and 0\.22\.1 to 0\.22\.2(-0)? stays in 0\.22\.x/);
      assert.equal(versionOf(dir), "0.22.1", `${level}: package.json unchanged`);
      assert.ok(fragmentPending(dir), `${level}: the fragment is still pending, not folded`);
      assert.equal(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), changelog, `${level}: CHANGELOG.md unchanged`);
    }
  } finally {
    await gh.close();
  }
}, 120_000);

test("this repository's preversion lets npm version minor, and preminor, take a breaking change", async () => {
  const gh = await noHolds();
  try {
    for (const [level, version] of [["minor", "0.23.0"], ["preminor", "0.23.0-0"]]) {
      const dir = wiredProject(BREAKING);
      const result = await npm(dir, ["version", level!, "--no-git-tag-version"], gh.url);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(versionOf(dir), version);
      assert.ok(!fragmentPending(dir), `${level}: the version hook folded the fragment`);
      assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), new RegExp(`## ${version.replace(/[.]/g, "\\.")} — [^\\n]*\\n\\n### Breaking\\n\\n- \\*\\*Hosts:\\*\\* a breaking change\\.`));
    }
  } finally {
    await gh.close();
  }
}, 120_000);
