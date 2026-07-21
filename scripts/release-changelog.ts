// Runs as npm's `version` lifecycle hook (see package.json): at that point
// package.json already carries the new version, and files staged here are
// included in the release commit that `npm version` then creates and tags.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const path = "CHANGELOG.md";
const text = readFileSync(path, "utf8");

const header = text.match(/^## Unreleased[ \t]*$/m);
if (!header || header.index === undefined) {
  console.error("CHANGELOG.md: no '## Unreleased' section — add one before releasing.");
  process.exit(1);
}

const escaped = version.replace(/[.]/g, "\\.");
if (new RegExp(`^## ${escaped}([^0-9]|$)`, "m").test(text)) {
  console.error(`CHANGELOG.md: a '## ${version}' section already exists.`);
  process.exit(1);
}

const afterHeader = text.slice(header.index + header[0].length);
const nextSection = afterHeader.search(/^## /m);
const unreleasedBody = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
if (!/^\s*[-*] /m.test(unreleasedBody)) {
  console.error(`CHANGELOG.md: '## Unreleased' has no entries — nothing to release as ${version}.`);
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 10);
writeFileSync(path, text.replace(header[0], `## Unreleased\n\n## ${version} — ${date}`));
console.log(`CHANGELOG.md: cut Unreleased into '## ${version} — ${date}'.`);
