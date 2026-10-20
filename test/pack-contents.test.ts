// scripts/pack-contents.mjs, which this repository's prepack runs: each case
// packs a throwaway package that has this repository's prepack and the
// script beside it, in a git checkout or a plain directory, with npm kept to
// that directory.
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/pack-contents.mjs", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway package with this repository's prepack and the script, whose
 *  files lists recipes and the built Web UI unless `files` says otherwise,
 *  and whose .gitignore names dist/, my-recipe.json and data/ as the host's
 *  does unless `gitignore` says otherwise: with the built Web UI unless
 *  `webUi` is false, and in a git checkout unless `git` is false. */
function project({ webUi = true, git = true, files = ["recipes", "dist/web"], gitignore = "dist/\nmy-recipe.json\ndata/\n" } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-contents-"));
  made.push(dir);
  const { prepack } = (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { scripts: Record<string, string> }).scripts;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "zz-host", version: "1.0.0", files, scripts: { prepack } }));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(SCRIPT, join(dir, "scripts", "pack-contents.mjs"));
  mkdirSync(join(dir, "recipes"));
  writeFileSync(join(dir, "recipes", "mock-test.json"), "{}\n");
  writeFileSync(join(dir, ".gitignore"), gitignore);
  if (webUi) {
    mkdirSync(join(dir, "dist", "web", "assets"), { recursive: true });
    writeFileSync(join(dir, "dist", "web", "index.html"), "<script src=\"./assets/app.js\"></script>\n");
    writeFileSync(join(dir, "dist", "web", "assets", "app.js"), "\n");
  }
  if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/** npm in `dir`, with its own home, cache and user config there. */
function npm(dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // As in release-holds.test.ts: npm's own CLI under `npm test`, the npm on
  // PATH otherwise.
  const cli = process.env.npm_execpath;
  const [file, argv] = cli && /npm-cli\.c?js$/.test(cli) ? ["node", [cli, ...args]] : ["npm", args];
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    npm_config_cache: join(dir, ".npm-cache"),
    npm_config_userconfig: join(dir, ".npmrc"),
    npm_config_update_notifier: "false",
    npm_config_registry: "http://127.0.0.1:9/",
    npm_config_fetch_retries: "0",
  };
  return run(file, argv, dir, env);
}

/** `bun pm pack --dry-run` in `dir`, with the bun running these tests and
 *  the same home as npm(). */
function bunPack(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(process.execPath, ["pm", "pack", "--dry-run"], dir, { PATH: process.env.PATH ?? "", HOME: dir });
}

function run(file: string, argv: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, argv, { cwd, env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test("a tree with the Web UI built, and nothing git ignores outside it, packs, the built Web UI included", async () => {
  const dir = project();
  const result = await npm(dir, ["pack", "--dry-run", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  // npm 11 prints an array of records, npm 12 an object keyed by name.
  const parsed = JSON.parse(result.stdout) as { files: { path: string }[] }[] | Record<string, { files: { path: string }[] }>;
  const record = Array.isArray(parsed) ? parsed[0]! : Object.values(parsed)[0]!;
  const files = record.files.map((file) => file.path).sort();
  assert.deepEqual(files, ["dist/web/assets/app.js", "dist/web/index.html", "package.json", "recipes/mock-test.json"]);
  assert.doesNotMatch(result.stderr, /pack-contents: /);
}, 30_000);

test("a tree where git ignores none of the files to pack packs without a word", async () => {
  // git check-ignore exits 1 here, which is "none", not "can't tell".
  const result = await npm(project({ gitignore: "my-recipe.json\n" }), ["pack", "--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /pack-contents: /);
}, 30_000);

test("a local file git ignores, in a directory files lists, stops npm pack, npm publish and bun pm pack, named", async () => {
  const dir = project();
  writeFileSync(join(dir, "recipes", "my-recipe.json"), "{}\n");
  mkdirSync(join(dir, "recipes", "data"));
  writeFileSync(join(dir, "recipes", "data", "notes.txt"), "zz\n");
  const expected =
    "pack-contents: package.json's files would pack 2 files that git ignores:\n" +
    "  recipes/data/notes.txt\n  recipes/my-recipe.json\nMove them out of the tree, or pack from a clean checkout.";
  for (const [name, packing] of [
    ["npm pack", () => npm(dir, ["pack", "--dry-run"])],
    ["npm publish", () => npm(dir, ["publish", "--dry-run"])],
    ["bun pm pack", () => bunPack(dir)],
  ] as const) {
    const result = await packing();
    assert.notEqual(result.code, 0, `${name}: ${result.stdout}`);
    assert.ok(result.stderr.includes(expected), `${name}: ${result.stderr}`);
  }
  // A file git tracks isn't a local one, whatever .gitignore says.
  rmSync(join(dir, "recipes", "data"), { recursive: true });
  execFileSync("git", ["add", "-f", "recipes/my-recipe.json"], { cwd: dir });
  const tracked = await npm(dir, ["pack", "--dry-run"]);
  assert.equal(tracked.code, 0, tracked.stderr);
}, 30_000);

test("a file git ignores in a listed directory outside dist/web stops the pack, even beside the built Web UI", async () => {
  const dir = project({ files: ["recipes", "dist"] });
  writeFileSync(join(dir, "dist", "notes.txt"), "zz\n");
  const result = await npm(dir, ["pack", "--dry-run"]);
  assert.notEqual(result.code, 0, result.stdout);
  assert.ok(result.stderr.includes("pack-contents: package.json's files would pack a file that git ignores:\n  dist/notes.txt\nMove it out"), result.stderr);
}, 30_000);

test("a tree without the built Web UI doesn't pack", async () => {
  const result = await npm(project({ webUi: false }), ["pack", "--dry-run"]);
  assert.notEqual(result.code, 0);
  assert.ok(
    result.stderr.includes(
      "pack-contents: dist/web/index.html is missing: the package carries the Web UI built. Build it (npm run build:web:ci) " +
        "before packing; in the publish workflow it comes from the pack-check job's web-ui artifact.",
    ),
    result.stderr,
  );
}, 30_000);

test("outside a git checkout a pack goes ahead, saying it can't tell what git ignores, and an npm publish stops", async () => {
  const dir = project({ git: false });
  writeFileSync(join(dir, "recipes", "my-recipe.json"), "{}\n");
  const result = await npm(dir, ["pack", "--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /pack-contents: warning: this isn't a git checkout, so git couldn't say which of the files to pack it ignores \(.*\), and they weren't checked for local files\./);
  const published = await npm(dir, ["publish", "--dry-run"]);
  assert.notEqual(published.code, 0, published.stdout);
  assert.match(published.stderr, /pack-contents: this is a publish from a tree with no \.git above it, so git couldn't say which of the files to pack it ignores \(.*\), and a local file could ship: publish from a git checkout\./);
}, 30_000);

test("in a git checkout git can't read, the pack stops, saying why", async () => {
  // A .git that points at a missing repository: git exits 128 here, as it
  // does for a checkout another user owns or an unreadable index.
  const dir = project({ git: false });
  writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "missing")}\n`);
  const result = await npm(dir, ["pack", "--dry-run"]);
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /pack-contents: git couldn't say which of the files to pack it ignores \(fatal: not a git repository.*?\)\. This is a git checkout \(.*?\.git\), where a local file could ship, so the pack stops: fix what git reports and pack again\./);
}, 30_000);
