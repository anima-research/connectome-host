// Black-box coverage of scripts/release-changelog.ts: each case runs the
// real script in a throwaway directory, so assembly, validation, and the
// deletion of consumed fragments are all exercised exactly as `npm version`
// would run them.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../scripts/release-changelog.ts", import.meta.url),
);
const BUMP = fileURLToPath(new URL("../scripts/release-bump.mjs", import.meta.url));

const BASE_CHANGELOG = [
  "# Changelog",
  "",
  "Intro that mentions ## Unreleased inline, which must not count as a heading.",
  "",
  "## Unreleased",
  "",
  "## 1.0.0 — 2026-01-01",
  "",
  "### Fixed",
  "",
  "- Old entry.",
  "",
].join("\n");

interface Fixture {
  version?: string;
  changelog?: string;
  fragments?: Record<string, string>;
  /** package.json's other fields, such as an earlier release's connectomeRelease. */
  pkg?: Record<string, unknown>;
  /** RELEASE_CACHE_WRITE, unset when left out. */
  cacheWrite?: string;
}

function setup(f: Fixture): string {
  const dir = mkdtempSync(join(tmpdir(), "release-changelog-"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture", version: f.version ?? "1.1.0", ...f.pkg }, null, 2)}\n`,
  );
  if (f.cacheWrite !== undefined) writeFileSync(join(dir, ".cache-write"), f.cacheWrite);
  writeFileSync(join(dir, "CHANGELOG.md"), f.changelog ?? BASE_CHANGELOG);
  mkdirSync(join(dir, "changelog.d"));
  writeFileSync(join(dir, "changelog.d", "README.md"), "# Pending fragments\n");
  for (const [name, body] of Object.entries(f.fragments ?? {})) {
    const path = join(dir, "changelog.d", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

function run(dir: string): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.RELEASE_CACHE_WRITE;
  try {
    env.RELEASE_CACHE_WRITE = readFileSync(join(dir, ".cache-write"), "utf8");
  } catch {
    // Unset: the fixture gave none.
  }
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function section(text: string, version: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${version} — `));
  assert.notEqual(start, -1, `no '## ${version}' section in:\n${text}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return rest.slice(0, end === -1 ? undefined : end).join("\n").trim();
}

const changelog = (dir: string) => readFileSync(join(dir, "CHANGELOG.md"), "utf8");
const pkgText = (dir: string) => readFileSync(join(dir, "package.json"), "utf8");
const release = (dir: string) => (JSON.parse(pkgText(dir)) as { connectomeRelease?: unknown }).connectomeRelease;
const pending = (dir: string) => readdirSync(join(dir, "changelog.d")).sort();

test("folds fragments into a versioned section in canonical order and deletes them", () => {
  const dir = setup({
    fragments: {
      "z-later.fixed.md": "- Fixed thing.\n",
      "a-first.added.md": "- Added thing,\n  continued on an indented line.\n",
      "m.breaking.md": "- **Module authors:** breaking thing.\n",
    },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const text = changelog(dir);
  assert.equal(
    section(text, "1.1.0"),
    [
      "### Breaking",
      "",
      "- **Module authors:** breaking thing.",
      "",
      "### Added",
      "",
      "- Added thing,",
      "  continued on an indented line.",
      "",
      "### Fixed",
      "",
      "- Fixed thing.",
    ].join("\n"),
  );
  assert.match(text, /^## Unreleased\n\n## 1\.1\.0 — \d{4}-\d{2}-\d{2}\n/m, "fresh empty Unreleased above the cut");
  assert.ok(text.startsWith("# Changelog\n\nIntro that mentions"), "file header preserved");
  assert.equal(section(text, "1.0.0"), "### Fixed\n\n- Old entry.", "older section untouched");
  assert.deepEqual(pending(dir), ["README.md"], "consumed fragments deleted, README kept");
});

test("merges fragments into directly-filed Unreleased entries, reordering subsections canonically", () => {
  const dir = setup({
    changelog: BASE_CHANGELOG.replace(
      "## Unreleased\n",
      "## Unreleased\n\n### Fixed\n\n- Manual fix.\n\n### Added\n\n- Manual add.\n",
    ),
    fragments: { "x.fixed.md": "- Fragment fix.\n" },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    section(changelog(dir), "1.1.0"),
    "### Added\n\n- Manual add.\n\n### Fixed\n\n- Manual fix.\n\n- Fragment fix.",
  );
});

test("breaking fragments join an audience-qualified Breaking heading", () => {
  const dir = setup({
    changelog: BASE_CHANGELOG.replace(
      "## Unreleased\n",
      "## Unreleased\n\n### Fixed\n\n- Manual fix.\n\n### Breaking (module authors only)\n\n- Manual break.\n",
    ),
    fragments: { "b.breaking.md": "- Fragment break.\n" },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    section(changelog(dir), "1.1.0"),
    "### Breaking (module authors only)\n\n- Manual break.\n\n- Fragment break.\n\n### Fixed\n\n- Manual fix.",
  );
});

test("accepts nested bullets and multi-line continuations", () => {
  const dir = setup({
    fragments: { "n.fixed.md": "- one\n  - nested\n  more text\n- two\n" },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(section(changelog(dir), "1.1.0"), "### Fixed\n\n- one\n  - nested\n  more text\n- two");
});

test("accepts bullet content that merely resembles headings or rules", () => {
  const body = "- **Module authors:** bold opener.\n- -1 is now the sentinel.\n- #123 is referenced inline.\n- ***emphasis*** then text.\n";
  const dir = setup({ fragments: { "r.fixed.md": body } });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(section(changelog(dir), "1.1.0"), `### Fixed\n\n${body.trim()}`);
});

test("records the release's own fields in package.json, breaking and cacheWrite, and keeps every other field", () => {
  const others = { description: "kept", files: ["dist"], engines: { bun: ">=1.3.0" }, dependencies: { a: "^1.0.0" } };
  const dir = setup({
    pkg: others,
    cacheWrite: "yes@1.1.0",
    fragments: { "b.breaking.md": "- **Recipe authors:** breaking thing.\n", "f.fixed.md": "- Fixed thing.\n" },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(release(dir), { breaking: true, cacheWrite: true });
  assert.match(r.stdout, /package\.json: connectomeRelease records breaking true and cacheWrite true\./);
  const { connectomeRelease: _, ...rest } = JSON.parse(pkgText(dir)) as Record<string, unknown>;
  assert.deepEqual(rest, { name: "fixture", version: "1.1.0", ...others }, "every other field comes through unchanged");
  assert.ok(pkgText(dir).endsWith("}\n") && pkgText(dir).includes('\n  "name": "fixture",'), "two-space JSON with a final newline");
});

test("replaces an earlier release's fields, records no cost when RELEASE_CACHE_WRITE is unset, and no@<version> as false", () => {
  const earlier = { connectomeRelease: { breaking: true, cacheWrite: true } };
  const unset = setup({ pkg: earlier, fragments: { "f.fixed.md": "- Fixed thing.\n" } });
  const r = run(unset);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(release(unset), { breaking: false }, "the fields describe this release alone");
  assert.match(r.stdout, /records breaking false and nothing of its cache cost \(RELEASE_CACHE_WRITE unset\)\./, "the cut says no cost was recorded");

  const no = setup({ cacheWrite: "no@1.1.0", pkg: earlier, fragments: { "f.fixed.md": "- Fixed thing.\n" } });
  const n = run(no);
  assert.equal(n.status, 0, n.stderr);
  assert.deepEqual(release(no), { breaking: false, cacheWrite: false });
  assert.match(n.stdout, /records breaking false and cacheWrite false\./);
});

test("reads a Breaking subsection as the bump check does: prose under a qualified heading counts, an empty heading doesn't", () => {
  const prose = setup({
    changelog: BASE_CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n### Breaking (recipe authors only)\n\nRecipe authors rename `x` to `y`.\n"),
    fragments: { "f.fixed.md": "- Fixed thing.\n" },
  });
  const p = run(prose);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(release(prose), { breaking: true });

  const empty = setup({
    changelog: BASE_CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n### Breaking\n"),
    fragments: { "f.fixed.md": "- Fixed thing.\n" },
  });
  const e = run(empty);
  assert.equal(e.status, 0, e.stderr);
  assert.deepEqual(release(empty), { breaking: false });
});

test("records breaking since the last final release: a final release after a breaking prerelease is breaking, the next one isn't", () => {
  const dir = setup({ version: "1.1.0-0", fragments: { "b.breaking.md": "- **Recipe authors:** breaking thing.\n" } });
  const cut = (version: string) => {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "fixture", version }, null, 2)}\n`);
    writeFileSync(join(dir, "changelog.d", `${version}.fixed.md`), `- Fixed in ${version}.\n`);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    return release(dir);
  };
  assert.deepEqual(cut("1.1.0-0"), { breaking: true });
  assert.deepEqual(cut("1.1.0-1"), { breaking: true }, "a later prerelease of the line");
  assert.deepEqual(cut("1.1.0"), { breaking: true }, "the final release finishing the line");
  assert.deepEqual(cut("1.1.1"), { breaking: false }, "past the last final release");
});

test("reads back to the first final release's heading, and counts a heading it can't read", () => {
  const history = (...sections: string[]) => ["# Changelog", "", "## Unreleased", "", ...sections].join("\n");
  const breaking = (heading: string) => `${heading}\n\n### Breaking\n\n- A change.\n`;
  const fixed = (heading: string) => `${heading}\n\n### Fixed\n\n- A fix.\n`;
  const rows: Array<[string, string, string, boolean]> = [
    ["a first release, with nothing below Unreleased", "1.0.0", history(), false],
    ["a prerelease line with fixes alone", "1.2.0", history(fixed("## 1.2.0-1 — 2026-02-02"), fixed("## 1.2.0-0 — 2026-02-01"), breaking("## 1.1.0 — 2026-01-01")), false],
    ["a breaking prerelease of the line", "1.2.0", history(fixed("## 1.2.0-1 — 2026-02-02"), breaking("## 1.2.0-0 — 2026-02-01"), fixed("## 1.1.0 — 2026-01-01")), true],
    ["a final heading with build metadata", "1.1.1", history(fixed("## 1.1.0+build-1 — 2026-02-01"), breaking("## 1.1.0-0 — 2026-01-01")), false],
    ["a final heading with its date glued on", "1.1.1", history(fixed("## 1.1.0—2026-02-01"), breaking("## 1.1.0-0 — 2026-01-01")), false],
    ["a final heading with two spaces, which counts", "1.1.1", history(fixed("##  1.1.0 — 2026-02-01"), breaking("## 1.1.0-0 — 2026-01-01")), true],
    ["a breaking prerelease heading with a v, which counts", "1.2.0", history(breaking("## v1.2.0-0 — 2026-02-01"), fixed("## 1.1.0 — 2026-01-01")), true],
  ];
  for (const [name, version, changelog, expected] of rows) {
    const dir = setup({ version, changelog, fragments: { "f.fixed.md": "- Fixed thing.\n" } });
    const r = run(dir);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.deepEqual(release(dir), { breaking: expected }, name);
  }
});

// release-bump.mjs is vendored, so this script reads a Breaking subsection
// with its own copy of the rule; both read the same pending entries alike,
// under Unreleased or as a fragment.
test("reads a pending breaking entry as release-bump.mjs does", () => {
  const bodies: Array<[string, string]> = [
    ["Breaking", "- **Recipe authors:** a bullet.\n"],
    ["Breaking", "* a star bullet.\n"],
    ["Breaking", "+ a plus bullet.\n"],
    ["Breaking", "1. A numbered item.\n"],
    ["Breaking", "Prose, with no list at all.\n"],
    ["Breaking (module authors only)", "- A change.\n"],
    ["BREAKING", "- A change.\n"],
    ["breaking changes", "Prose.\n"],
    ["Breaking", ""],
    ["Changed (module authors)", "Prose about a change.\n"],
  ];
  const rows: Array<[string, Fixture]> = bodies.map(([title, body]) => [
    `'### ${title}' over ${JSON.stringify(body)}`,
    {
      changelog: BASE_CHANGELOG.replace("## Unreleased\n", `## Unreleased\n\n### ${title}\n\n${body}`),
      fragments: { "f.fixed.md": "- Fixed thing.\n" },
    },
  ]);
  rows.push(["a breaking fragment", { fragments: { "b.breaking.md": "- A change.\n", "f.fixed.md": "- Fixed thing.\n" } }]);
  for (const [name, fixture] of rows) {
    const dir = setup(fixture);
    let bumpRefused: boolean;
    try {
      execFileSync(process.execPath, [BUMP], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "", npm_old_version: "1.0.0", npm_new_version: "1.0.1" },
      });
      bumpRefused = false;
    } catch (e) {
      const err = e as { status: number; stderr?: string };
      assert.equal(err.status, 1, `${name}: release-bump.mjs exited ${err.status}`);
      assert.match(err.stderr ?? "", /^Release refused: a breaking change is pending/, `${name}: ${err.stderr}`);
      bumpRefused = true;
    }
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal((release(dir) as { breaking: boolean }).breaking, bumpRefused, name);
  }
});

/** A pattern matching `text` as written. */
const literal = (text: string) => new RegExp(text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"));

const refusals: Array<[string, Fixture, RegExp]> = [
  ["nothing to release", {}, /nothing to release as 1\.1\.0/],
  ["duplicate version section", { version: "1.0.0", fragments: { "a.fixed.md": "- x\n" } }, /'## 1\.0\.0' section already exists/],
  ["duplicate version section with a bare heading", { version: "1.0.0", changelog: BASE_CHANGELOG.replace("## 1.0.0 — 2026-01-01", "## 1.0.0"), fragments: { "a.fixed.md": "- x\n" } }, /'## 1\.0\.0' section already exists/],
  ["duplicate version section with a tab after its version", { version: "1.0.0", changelog: BASE_CHANGELOG.replace("## 1.0.0 — 2026-01-01", "## 1.0.0\t— 2026-01-01"), fragments: { "a.fixed.md": "- x\n" } }, /'## 1\.0\.0' section already exists/],
  ["unrecognized category suffix", { fragments: { "oops.md": "- x\n" } }, /changelog\.d\/oops\.md: unrecognized file/],
  ["stray non-markdown file", { fragments: { "notes.txt": "hi\n", "a.fixed.md": "- x\n" } }, /changelog\.d\/notes\.txt: unrecognized file/],
  ["empty fragment", { fragments: { "e.fixed.md": "\n" } }, /changelog\.d\/e\.fixed\.md: empty fragment/],
  ["fragment nested under a branch-name directory", { fragments: { "fix/foo.fixed.md": "- x\n", "a.fixed.md": "- y\n" } }, /changelog\.d\/fix: not a file/],
  ["plain prose", { fragments: { "p.fixed.md": "prose only\n" } }, /offending line: 'prose only'/],
  ["prose after a valid bullet", { fragments: { "p.fixed.md": "- ok\nrogue prose\n" } }, /offending line: 'rogue prose'/],
  ["top-level heading after a bullet", { fragments: { "h.fixed.md": "- ok\n\n## 9.9.9 — fake\n" } }, /offending line: '## 9\.9\.9 — fake'/],
  ["indented ATX heading", { fragments: { "h.fixed.md": "- ok\n  ## 8.8.8 — injected\n  - beneath\n" } }, /offending line: '  ## 8\.8\.8 — injected'/],
  ["indented setext underline / rule", { fragments: { "s.fixed.md": "- ok\n  ---\n" } }, /offending line: '  ---'/],
  ["spaced thematic break shaped like a bullet", { fragments: { "s.fixed.md": "- ok\n- - -\n" } }, /offending line: '- - -'/],
  ["asterisk thematic break with spaces", { fragments: { "s.fixed.md": "- ok\n* * *\n" } }, /offending line: '\* \* \*'/],
  ["rule as bullet content", { fragments: { "s.fixed.md": "- ---\n" } }, /offending line: '- ---'/],
  ["heading as bullet content", { fragments: { "h.fixed.md": "- ## 9.9.9 — embedded heading\n" } }, /offending line: '- ## 9\.9\.9 — embedded heading'/],
  ["heading as nested bullet content", { fragments: { "h.fixed.md": "- ok\n  - ### nested heading\n" } }, /offending line: '  - ### nested heading'/],
  ["tab-indented continuation", { fragments: { "t.fixed.md": "- ok\n\tcontinued\n" } }, /offending line: '\tcontinued'/],
  ["no Unreleased heading", { changelog: "# Changelog\n\n## 1.0.0 — 2026-01-01\n\n- x\n", fragments: { "a.fixed.md": "- x\n" } }, /no '## Unreleased' section/],
  ["two Unreleased headings", { changelog: BASE_CHANGELOG + "\n## Unreleased\n\n- stranded\n", fragments: { "a.fixed.md": "- x\n" } }, /2 '## Unreleased' headings/],
  ...["maybe", "", "yes", "no", "true", "YES@1.1.0", "yes@1.1.0\n"].map((value): [string, Fixture, RegExp] => [
    `a RELEASE_CACHE_WRITE of ${JSON.stringify(value)}`,
    { cacheWrite: value, fragments: { "a.fixed.md": "- x\n" } },
    literal(`RELEASE_CACHE_WRITE is ${JSON.stringify(value)}: give yes@1.1.0 if`),
  ]),
  ["a RELEASE_CACHE_WRITE naming another version", { cacheWrite: "yes@1.0.0", fragments: { "a.fixed.md": "- x\n" } }, /RELEASE_CACHE_WRITE is "yes@1\.0\.0", which names 1\.0\.0, but this cut is 1\.1\.0: give yes@1\.1\.0 or no@1\.1\.0 for this release/],
];

for (const [name, fixture, message] of refusals) {
  test(`refuses ${name} without touching anything`, () => {
    const dir = setup(fixture);
    const before = { changelog: changelog(dir), pending: pending(dir), pkg: pkgText(dir) };
    const r = run(dir);
    assert.equal(r.status, 1, `expected refusal, got exit ${r.status}:\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, message);
    assert.equal(changelog(dir), before.changelog, "CHANGELOG.md must be untouched");
    assert.deepEqual(pending(dir), before.pending, "no fragment may be deleted on refusal");
    assert.equal(pkgText(dir), before.pkg, "package.json must be untouched");
  });
}
