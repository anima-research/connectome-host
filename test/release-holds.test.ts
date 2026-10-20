// This repository's wiring of scripts/release-holds.mjs, a copy of
// agent-framework's, whose own suite tests the check itself (see the
// script's header). Each case runs npm or bun with this repository's
// preversion, prepublishOnly and prepack entries against a local stand-in
// for GitHub's issues endpoint, or runs the script with this repository's
// own package.json, so the hooks that make a release stop, and the
// repository they ask, are tested here.
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../scripts/release-holds.mjs", import.meta.url),
);
const PACK_CONTENTS = fileURLToPath(new URL("../scripts/pack-contents.mjs", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
// preversion runs the bump check before the hold check.
const BUMP = fileURLToPath(new URL("../scripts/release-bump.mjs", import.meta.url));

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}

/** Answers every request with `status` and `body`, or with what `body`
 *  gives for the request's URL, recording each request. A `raw` body is
 *  sent as it is, not as JSON. */
async function github(
  status: number,
  body: unknown | ((url: string) => unknown),
  raw = false,
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    seen.push({ url, headers: req.headers });
    res.writeHead(status, { "content-type": "application/json" });
    const answer = typeof body === "function" ? (body as (url: string) => unknown)(url) : body;
    res.end(raw ? String(answer) : JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway directory with this package.json (or this raw text). */
function project(pkg: Record<string, unknown> | string): string {
  const dir = mkdtempSync(join(tmpdir(), "release-holds-"));
  made.push(dir);
  writeFileSync(join(dir, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg));
  return dir;
}

const PKG = {
  name: "fixture",
  version: "1.0.0",
  repository: { type: "git", url: "git+https://github.com/owner/repo.git" },
};

const HOLD = { number: 300, title: "DefaultErrorPolicy sleeps the provider's retryAfterMs uncapped" };

/** Runs `file` with `args` and only the environment given, so a CI
 *  runner's own GITHUB_REPOSITORY or token can't reach it. */
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

// Under node, not the test runner's bun: npm runs it with node.
const run = (cwd: string, env: Record<string, string>) => exec("node", [SCRIPT], cwd, env);

/** A throwaway package whose preversion, prepublishOnly and prepack are this
 *  repository's own, with their scripts beside them, in a git checkout with
 *  the built Web UI that prepack requires. */
function wiredProject(): string {
  const scripts = (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { scripts: Record<string, string> }).scripts;
  const dir = project({
    ...PKG,
    scripts: { preversion: scripts.preversion, prepublishOnly: scripts.prepublishOnly, prepack: scripts.prepack },
  });
  mkdirSync(join(dir, "scripts"));
  copyFileSync(SCRIPT, join(dir, "scripts", "release-holds.mjs"));
  copyFileSync(BUMP, join(dir, "scripts", "release-bump.mjs"));
  copyFileSync(PACK_CONTENTS, join(dir, "scripts", "pack-contents.mjs"));
  writeFileSync(join(dir, ".npmrc"), "");
  mkdirSync(join(dir, "dist", "web"), { recursive: true });
  writeFileSync(join(dir, "dist", "web", "index.html"), "");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/** npm, kept to the throwaway directory: its own cache and user config,
 *  and the stand-in for its registry and GitHub's API. */
function npm(dir: string, args: string[], api: string) {
  // Under `npm test`, npm names its own CLI script in npm_execpath, and node
  // runs it: a bare `npm` is npm.cmd on Windows, which execFile can't start
  // without a shell. Another package manager names its own CLI there (under
  // `bun test`, bun's binary), so anything but npm's script falls back to the
  // `npm` on PATH.
  const cli = process.env.npm_execpath;
  const [file, argv] = cli && /npm-cli\.c?js$/.test(cli) ? ["node", [cli, ...args]] : ["npm", args];
  return exec(file, argv, dir, {
    HOME: dir,
    npm_config_cache: join(dir, ".npm-cache"),
    npm_config_userconfig: join(dir, ".npmrc"),
    npm_config_registry: api,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    GITHUB_API_URL: api,
  });
}

/** bun, kept to the throwaway directory as npm is: under `bun test`, the
 *  running binary. */
function bun(dir: string, args: string[], api: string) {
  return exec(process.execPath, args, dir, {
    HOME: dir,
    BUN_INSTALL_CACHE_DIR: join(dir, ".bun-cache"),
    npm_config_registry: api,
    GITHUB_API_URL: api,
  });
}

test("bun's version and publish commands run this repository's hooks, so a hold stops them too", async () => {
  const gh = await github(200, [HOLD]);
  try {
    const dir = wiredProject();
    const version = await bun(dir, ["pm", "version", "patch", "--no-git-tag-version"], gh.url);
    assert.notEqual(version.code, 0);
    assert.match(version.stderr, /#300 DefaultErrorPolicy/);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "1.0.0");
    const publish = await bun(dir, ["publish", "--dry-run"], gh.url);
    assert.notEqual(publish.code, 0);
    assert.match(publish.stderr, /#300 DefaultErrorPolicy/);
  } finally {
    await gh.close();
  }
}, 30_000);

test("this repository's preversion stops npm version before the bump while a hold is open", async () => {
  const gh = await github(200, [HOLD]);
  try {
    const dir = wiredProject();
    const result = await npm(dir, ["version", "patch", "--no-git-tag-version"], gh.url);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /#300 DefaultErrorPolicy/);
    assert.match(result.stderr, /then run npm version again\./);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "1.0.0");
  } finally {
    await gh.close();
  }
}, 30_000);

test("with no hold open, this repository's preversion lets npm version bump", async () => {
  const gh = await github(200, []);
  try {
    const dir = wiredProject();
    const result = await npm(dir, ["version", "patch", "--no-git-tag-version"], gh.url);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "1.0.1");
    assert.ok(gh.seen.some((s) => s.url.startsWith("/repos/owner/repo/issues?")));
  } finally {
    await gh.close();
  }
}, 30_000);

test("this repository's prepublishOnly stops npm publish while a hold is open", async () => {
  const gh = await github(200, [HOLD]);
  try {
    const dir = wiredProject();
    const result = await npm(dir, ["publish", "--dry-run"], gh.url);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /#300 DefaultErrorPolicy/);
    assert.match(result.stderr, /then run npm publish again\./);
  } finally {
    await gh.close();
  }
}, 30_000);

test("with no hold open, this repository's prepublishOnly lets npm publish go ahead", async () => {
  const gh = await github(200, []);
  try {
    const dir = wiredProject();
    const result = await npm(dir, ["publish", "--dry-run"], gh.url);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(gh.seen.some((s) => s.url.startsWith("/repos/owner/repo/issues?")));
  } finally {
    await gh.close();
  }
}, 30_000);

test("this repository's own package.json sends the check to anima-research/connectome-host", async () => {
  const gh = await github(200, []);
  try {
    const result = await run(fileURLToPath(new URL("..", import.meta.url)), { GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: "fork/repo" });
    assert.equal(result.code, 0, result.stderr);
    assert.match(gh.seen[0]!.url, /^\/repos\/anima-research\/connectome-host\/issues\?/);
  } finally {
    await gh.close();
  }
});
