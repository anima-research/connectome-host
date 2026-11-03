// A copy of agent-framework's scripts/release-bump.mjs
// (https://github.com/anima-research/agent-framework), taken from commit
// 19cd94a (pull request #348), and the same apart from this opening comment
// and the version hook's name in two comments, release-changelog.ts here.
// A change to the check lands there first, with its tests, and is then
// ported here with this commit updated, its tests with it
// (test/release-bump.test.ts, under bun:test).
//
// Runs in npm's `preversion` lifecycle hook (see package.json), where npm
// gives both versions (npm_old_version, npm_new_version) before it writes
// anything: npm 8, 9, 10 and 11.17 all do, checked with `npm version patch`
// in a throwaway package. While a breaking entry is pending, the new version
// must open a release line that no release has reached, so that no
// dependent's caret range takes it: before 1.0 a breaking change needs a new
// minor (0.22.x to 0.23.0), and from 1.0 a new major. A host that depends on
// `^0.22.1` then keeps 0.22.x until it raises its range in a change of its
// own, where the breaking entries are read.
//
// A breaking entry is pending when changelog.d/ holds a `<slug>.breaking.md`
// fragment, or when CHANGELOG.md's `## Unreleased` section has a subsection
// whose title starts with "Breaking" (in any case) with anything in it.
// release-changelog.ts releases those under that subsection's own title, or
// `### Breaking` for a fragment with no such subsection to join.
//
// A line is a version's minor before 1.0 (0.22.x), its major from 1.0 (1.x),
// and the version itself for 0.0.z, which `^0.0.z` alone takes. A final
// release's line has been reached. So has a prerelease's, unless it opens a
// line (x.y.0-n before 1.0, x.0.0-n from 1.0, any 0.0.z-n): from one of those,
// any version in its line goes ahead, finishing it included, since no release
// of that line exists for a dependent's range to hold. A prerelease target
// counts as the release it leads to, so a prepatch can't carry a breaking
// entry into a patch: the version hook would fold the pending entries into
// the prerelease's own section, where the next bump wouldn't see them. A
// version below the current one's line is refused too: a dependent's range
// may still hold that line.
import { existsSync, readdirSync, readFileSync } from "node:fs";

const CHANGELOG = "CHANGELOG.md";
const FRAGMENT_DIR = "changelog.d";

/** Where each pending breaking entry is filed. */
function pendingBreaking() {
  const found = [];
  if (existsSync(FRAGMENT_DIR)) {
    for (const name of readdirSync(FRAGMENT_DIR).sort()) {
      if (name.endsWith(".breaking.md")) found.push(`${FRAGMENT_DIR}/${name}`);
    }
  }
  if (existsSync(CHANGELOG)) {
    const text = readFileSync(CHANGELOG, "utf8");
    const header = text.match(/^## Unreleased[ \t]*$/m);
    if (header) {
      const after = text.slice(header.index + header[0].length);
      const end = after.search(/^## /m);
      const body = end === -1 ? after : after.slice(0, end);
      // Subsections in order; release-changelog.ts releases every line of a
      // Breaking subsection, bullet or not.
      let title = null;
      for (const line of body.split("\n")) {
        const h = line.match(/^###\s+(.*)$/);
        if (h) {
          title = h[1].trim();
        } else if (title && title.toLowerCase().startsWith("breaking") && line.trim() !== "") {
          found.push(`${CHANGELOG}: '### ${title}' under '## Unreleased'`);
          title = null;
        }
      }
    }
  }
  return found;
}

/** major.minor.patch with an optional prerelease, or null. */
function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(version ?? "");
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] !== undefined } : null;
}

/** A version's line: [major] from 1.0, [0, minor] before it, [0, 0, patch] for 0.0.z. */
function lineOf(v) {
  if (v.major > 0) return [v.major];
  return v.minor > 0 ? [0, v.minor] : [0, 0, v.patch];
}

/** Orders two lines. */
function compareLines(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const label = (line) => (line.length === 1 ? `${line[0]}.x` : line.length === 2 ? `0.${line[1]}.x` : `0.0.${line[2]}`);

/** Whether a prerelease opens a line no release has reached. */
function opensLine(v) {
  if (!v.pre) return false;
  if (v.major > 0) return v.minor === 0 && v.patch === 0;
  return v.minor > 0 ? v.patch === 0 : true;
}

/** The version npm's `minor` (before 1.0) or `major` bump gives, which opens the next line. */
function nextLine(v) {
  if (v.major > 0) return opensLine(v) ? `${v.major}.0.0` : `${v.major + 1}.0.0`;
  if (v.minor === 0) return "0.1.0";
  return opensLine(v) ? `0.${v.minor}.0` : `0.${v.minor + 1}.0`;
}

function main() {
  const pending = pendingBreaking();
  if (pending.length === 0) return 0;
  const oldVersion = process.env.npm_old_version;
  const newVersion = process.env.npm_new_version;
  const old = parse(oldVersion);
  const next = parse(newVersion);
  if (!old || !next) {
    console.error(
      "release-bump: a breaking change is pending, and this check needs npm version's old and new versions " +
        `to decide (npm_old_version=${oldVersion ?? "unset"}, npm_new_version=${newVersion ?? "unset"}): ` +
        "run it through npm version.",
    );
    return 1;
  }
  const order = compareLines(lineOf(next), lineOf(old));
  if (order > 0 || (order === 0 && opensLine(old))) return 0;
  const line = label(lineOf(old));
  const why =
    order < 0
      ? `goes back to ${label(lineOf(next))}, which a dependent's caret range may still hold`
      : next.pre
        ? `stays in ${line}: no caret range takes a prerelease, but the version hook would fold the pending ` +
          "entries into its own section, where the next version's check wouldn't see them"
        : `stays in ${line}, which a dependent's caret range on ${line} takes`;
  const [level, rule] =
    old.major === 0
      ? ["minor", "Before 1.0, a breaking change goes out in a new minor version"]
      : ["major", "A breaking change goes out in a new major version"];
  console.error(
    `Release refused: a breaking change is pending, and ${oldVersion} to ${newVersion} ${why}.\n` +
      pending.map((place) => `  ${place}\n`).join("") +
      `${rule}, which a dependent's range doesn't take until the dependent raises it. ` +
      `Run npm version ${level} (${oldVersion} to ${nextLine(old)}). Nothing has been bumped or written.`,
  );
  return 1;
}

process.exitCode = main();
