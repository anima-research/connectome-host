// Black-box coverage of scripts/pack-installs-alone.mjs: each case runs the
// real script under node, as the publish workflow runs it, in a throwaway
// stand-in for the host. The stand-in has no dependencies, so npm packs and
// installs it offline with its own cache. Its tree has the built Web UI,
// dist/web/index.html, which its `files` lists as the host's does, and its
// src/index.ts answers the smoke run as batch mode with the mock recipe
// does: '> line' for each line it reads, then the mock agent's queued reply,
// and only with the Web UI off and the mock's echo off.
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/pack-installs-alone.mjs", import.meta.url));
// The node on PATH, which runs the script as the workflows do (under
// `bun test`, process.execPath is bun). Found once, since a case may hand
// the script a PATH without it.
const NODE = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
const TIMEOUT_MS = 60_000;

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const HOST = `import { readFileSync } from "node:fs";
import { helper } from "./helper.ts";
const recipe = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (recipe.modules?.webui !== false) { console.error("zz: the Web UI is on"); process.exit(3); }
if (recipe.agent?.mock?.echoMode !== false) { console.error("zz: the mock echoes"); process.exit(4); }
if (recipe.agent?.name !== "zz-agent") { console.error("zz: the recipe's agent settings were dropped"); process.exit(5); }
const queue = [...(recipe.agent?.mock?.responseQueue ?? [])];
for (const line of readFileSync(0, "utf8").split("\\n").filter(Boolean)) console.log(\`> \${line}\\n\\n\${helper(queue.shift() ?? "")}\`);
`;
/** A stand-in host: package.json from `pkg` (its `files` listing src,
 *  recipes, the built Web UI and tsconfig.json unless `pkg` says otherwise),
 *  and its files, `index` being src/index.ts's text, the built Web UI and
 *  tsconfig.json among them. */
function standIn(pkg: Record<string, unknown>, index = HOST, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-installs-alone-test-"));
  made.push(dir);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "@zz/host", version: "1.0.0", type: "module", files: ["src", "recipes", "dist/web", "tsconfig.json"], ...pkg }),
    ".gitignore": "dist/\ntmp-*/\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    "src/index.ts": index,
    "src/helper.ts": "export const helper = (line: string): string => line;\n",
    "recipes/mock-test.json": JSON.stringify({ name: "Mock", agent: { name: "zz-agent" }, modules: { wake: false, webui: { host: "127.0.0.1" } } }),
    "dist/web/index.html": '<!doctype html>\n<link rel="stylesheet" href="/assets/app.css">\n<script type="module" src="./assets/app.js"></script>\n<script src="//cdn.example.invalid/x.js"></script>\n<a href="https://example.invalid/">x</a><a href="#top">top</a>\n',
    "dist/web/assets/app.css": "body {}\n",
    "dist/web/assets/app.js": "export {};\n",
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function check(dir: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  // npm's home and cache, outside the package, so npm pack doesn't take them in.
  const home = mkdtempSync(join(tmpdir(), "pack-installs-alone-home-"));
  made.push(home);
  return new Promise((resolve) => {
    execFile(NODE, [SCRIPT], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        npm_config_cache: join(home, ".npm-cache"),
        npm_config_userconfig: join(home, ".npmrc"),
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
        PACK_INSTALLS_ALONE_RETRY_DELAY_MS: "0",
        ...env,
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** A directory holding an `npm` that runs `body` with `args` (its
 *  arguments), `fs`, `bin` (this directory) and `pass()`, which runs the
 *  real npm with the same arguments. */
function npmShim(body: string): string {
  const bin = mkdtempSync(join(tmpdir(), "pack-installs-alone-npm-"));
  made.push(bin);
  const real = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node\nconst { execFileSync } = require("node:child_process");\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nconst bin = ${JSON.stringify(bin)};\nconst pass = () => { try { process.stdout.write(execFileSync(${JSON.stringify(real)}, args, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] })); } catch (error) { process.stdout.write(error.stdout ?? ""); process.exit(error.status ?? 1); } };\n${body}\n`,
    { mode: 0o755 },
  );
  return bin;
}
const withPath = (bin: string) => ({ PATH: `${bin}:${process.env.PATH ?? ""}` });

const smokeRun = "the offline smoke run \\(recipes\\/mock-test\\.json in batch mode, Web UI off\\) of the installed zz-host-1\\.0\\.0\\.tgz";

test("a package that carries its Web UI, installs alone, resolves and gives its queued reply with the Web UI off passes, naming the npm", async () => {
  const result = await check(standIn({}));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^> pack-installs-alone: hello\n\npack-installs-alone: reply [0-9a-f]{8}$/m);
  const npm = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim().replace(/\./g, "\\.");
  assert.match(
    result.stdout,
    new RegExp(`^zz-host-1\\.0\\.0\\.tgz \\(\\d+ files\\) installs on its own with npm ${npm}, running no install scripts; it carries the Web UI and tsconfig\\.json, src\\/index\\.ts's imports resolve, and the offline smoke run answered\\.$`, "m"),
  );
  assert.doesNotMatch(result.stderr, /warning/);
}, TIMEOUT_MS);

test("npm pack's JSON is read in npm 12's shape too, and a prepack's output doesn't break it", async () => {
  // npm 12 prints an object keyed by package name: a shim in front of the
  // real npm rewrites npm 11's array that way, and passes npm 12's through.
  const bin = mkdtempSync(join(tmpdir(), "pack-installs-alone-npm12-"));
  made.push(bin);
  const realNpm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node\nconst { execFileSync } = require("node:child_process");\nconst args = process.argv.slice(2);\ntry {\n  const out = execFileSync(${JSON.stringify(realNpm)}, args, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });\n  if (args[0] === "pack" && args.includes("--json")) {\n    const parsed = JSON.parse(out);\n    // npm 12 prints the object already; npm 11's array is rewritten.\n    process.stdout.write(Array.isArray(parsed) ? JSON.stringify({ [parsed[0].name]: parsed[0] }) : out);\n  } else process.stdout.write(out);\n} catch (error) { process.stdout.write(error.stdout ?? ""); process.exit(error.status ?? 1); }\n`,
    { mode: 0o755 },
  );
  const twelve = await check(standIn({}), { PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(twelve.code, 0, twelve.stderr);
  assert.match(twelve.stdout, /^zz-host-1\.0\.0\.tgz \(\d+ files\) installs on its own with npm /m);
  const chatty = await check(standIn({ scripts: { prepack: "echo zz: packing" } }));
  assert.equal(chatty.code, 0, chatty.stderr);
}, TIMEOUT_MS * 2);

test("a tree without the built Web UI is told to build it, before anything is packed", async () => {
  const dir = standIn({});
  rmSync(join(dir, "dist"), { recursive: true });
  const result = await check(dir);
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "pack-installs-alone: dist/web/index.html isn't in this tree: build the Web UI first (npm run build:web:ci), since the package carries it built.\n",
  );
}, TIMEOUT_MS);

test("a package whose files leave the Web UI out fails: npm 12 and bun installs would have none", async () => {
  for (const pkg of [{ files: ["src", "recipes"] }, { files: undefined }]) {
    const result = await check(standIn(pkg));
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /pack-installs-alone: the installed zz-host-1\.0\.0\.tgz has no dist\/web\/index\.html, though this tree has it: package\.json's files must list dist\/web, so that npm 12 and bun installs, which run no install scripts, get the Web UI\.\n$/,
    );
  }
}, TIMEOUT_MS * 2);

test("a package that carries the Web UI's index.html without the files it names fails, naming them", async () => {
  const result = await check(standIn({ files: ["src", "recipes", "dist/web/index.html", "tsconfig.json"] }));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /pack-installs-alone: the installed zz-host-1\.0\.0\.tgz's dist\/web\/index\.html names assets\/app\.css, assets\/app\.js, which aren't in the package: package\.json's files must list all of dist\/web, or the Web UI is a blank page\.\n$/,
  );
}, TIMEOUT_MS);

test("a package whose files leave tsconfig.json out fails: a consumer typechecks the source with it", async () => {
  const result = await check(standIn({ files: ["src", "recipes", "dist/web"] }));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /pack-installs-alone: the installed zz-host-1\.0\.0\.tgz has no tsconfig\.json: package\.json's files must list it, since the package ships its TypeScript source and a consumer typechecks that with it, as connectome-smoke's published lane does\.\n$/,
  );
}, TIMEOUT_MS);

test("the install runs no install scripts, the package's own included", async () => {
  const result = await check(standIn({ scripts: { postinstall: "echo 'zz: postinstall ran' >&2; exit 1" } }));
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /zz: postinstall ran/);
}, TIMEOUT_MS);

test("a dependency that can't be installed fails the install after three attempts, saying what does that", async () => {
  const result = await check(standIn({ dependencies: { "zz-not-on-the-registry": "1.0.0" } }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /pack-installs-alone: the install failed \(attempt 1 of 3\); trying again\./);
  assert.match(result.stderr, /pack-installs-alone: the install failed \(attempt 2 of 3\); trying again\./);
  assert.doesNotMatch(result.stderr, /attempt 3 of 3/);
  assert.match(
    result.stderr,
    /pack-installs-alone: zz-host-1\.0\.0\.tgz didn't install on its own into an empty directory, in 3 attempts \(npm's output is above\)\. A dependency that isn't on the registry does that, or a registry or network error that outlasts the attempts\.\n$/,
  );
  const bad = await check(standIn({}), { PACK_INSTALLS_ALONE_RETRY_DELAY_MS: "soon" });
  assert.equal(bad.code, 1);
  assert.equal(bad.stderr, "pack-installs-alone: PACK_INSTALLS_ALONE_RETRY_DELAY_MS is 'soon', not a whole number of milliseconds.\n");
}, TIMEOUT_MS * 2);

test("a file left out of the package fails the resolve, naming the entry", async () => {
  const result = await check(standIn({ files: ["src/index.ts", "recipes", "dist/web", "tsconfig.json"] }));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /pack-installs-alone: an import of src\/index\.ts doesn't resolve in the installed zz-host-1\.0\.0\.tgz \(bun's output is above\)\. A file missing from the package, or a dependency only devDependencies supplied, does that\.\n$/,
  );
}, TIMEOUT_MS);

test("a dependency only devDependencies supplied fails the resolve", async () => {
  const result = await check(standIn({ devDependencies: { "zz-dev-only": "1.0.0" } }, `import "zz-dev-only";\n${HOST}`));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /zz-dev-only/);
  assert.match(result.stderr, /pack-installs-alone: an import of src\/index\.ts doesn't resolve/);
}, TIMEOUT_MS);

test("a smoke recipe left out of the package fails, naming it", async () => {
  const result = await check(standIn({ files: ["src", "dist/web", "tsconfig.json"] }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /pack-installs-alone: the installed zz-host-1\.0\.0\.tgz has no readable recipes\/mock-test\.json: ENOENT/);
}, TIMEOUT_MS);

test("a smoke run that exits non-zero fails, with its exit code", async () => {
  const result = await check(standIn({}, `${HOST}process.exit(2);\n`));
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`pack-installs-alone: ${smokeRun} exited 2 \\(its output is above\\)\\.\\n$`));
}, TIMEOUT_MS);

test("a smoke run whose queued reply doesn't follow the message it took fails: none, one before it, another text, or no '> line'", async () => {
  const takes = `import { readFileSync } from "node:fs";\nimport { helper } from "./helper.ts";\nconst recipe = JSON.parse(readFileSync(process.argv[2], "utf8"));\nconst reply = recipe.agent.mock.responseQueue[0];\nconst taken = readFileSync(0, "utf8").trim();\n`;
  for (const index of [
    `${takes}console.log(\`> \${helper(taken)}\`);\n`,
    `${takes}console.log(\`\${reply}\\n> \${helper(taken)}\`);\n`,
    `${takes}console.log(\`> \${helper(taken)}\\n[Echo] \${taken}\`);\n`,
    `${takes}console.log(helper(reply));\n`,
  ]) {
    const result = await check(standIn({}, index));
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /exited 0, but the mock agent's queued reply, 'pack-installs-alone: reply [0-9a-f]{8}', didn't follow '> pack-installs-alone: hello' \(its output is above\)\.\n$/,
    );
  }
}, TIMEOUT_MS * 4);

test("a working tree that differs from HEAD gets a warning, and is checked as it stands", async () => {
  const dir = standIn({});
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=zz", "-c", "user.email=zz@zz.invalid", "add", "-A");
  git("-c", "user.name=zz", "-c", "user.email=zz@zz.invalid", "commit", "-q", "-m", "zz");
  const files = (out: string) => Number(/\((\d+) files\)/.exec(out)?.[1]);
  // Committed with the built Web UI ignored, as the host's .gitignore has it:
  // no warning for dist/web.
  const clean = await check(dir);
  assert.equal(clean.code, 0, clean.stderr);
  assert.doesNotMatch(clean.stderr, /warning/);
  writeFileSync(join(dir, "src", "untracked.ts"), "export const zz = 1;\n");
  const result = await check(dir);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stderr,
    /^pack-installs-alone: warning: the working tree differs from HEAD in 1 path \(src\/untracked\.ts\)\. npm pack packs the working tree, so this run checks whichever of them the package includes, where the publish workflow packs a clean checkout\.$/m,
  );
  // The untracked file went into the package that was checked.
  assert.equal(files(result.stdout), files(clean.stdout) + 1);
}, TIMEOUT_MS * 2);

test("@opentui/core must load in the installed tree, its native package with it", async () => {
  // Bundled, so the offline install takes it from the tarball.
  const opentui = (body: string) => ({
    "node_modules/@opentui/core/package.json": JSON.stringify({ name: "@opentui/core", version: "1.0.0", type: "module", main: "index.js" }),
    "node_modules/@opentui/core/index.js": body,
  });
  const pkg = { dependencies: { "@opentui/core": "1.0.0" }, bundleDependencies: ["@opentui/core"] };
  const loads = await check(standIn(pkg, HOST, opentui("export const ok = true;\n")));
  assert.equal(loads.code, 0, loads.stderr);
  assert.match(loads.stdout, /src\/index\.ts's imports resolve, @opentui\/core loads, and the offline smoke run answered\.$/m);
  const missing = await check(standIn(pkg, HOST, opentui(`await import(["@opentui", "core-zz-" + process.arch].join("/"));\n`)));
  assert.equal(missing.code, 1);
  // Listed as an optional dependency, it's probed all the same.
  const optional = { optionalDependencies: { "@opentui/core": "1.0.0" }, bundleDependencies: ["@opentui/core"] };
  const optionalMissing = await check(standIn(optional, HOST, opentui(`await import(["@opentui", "core-zz-" + process.arch].join("/"));\n`)));
  assert.equal(optionalMissing.code, 1);
  assert.match(optionalMissing.stderr, /pack-installs-alone: @opentui\/core doesn't load in the installed zz-host-1\.0\.0\.tgz/);
  assert.match(
    missing.stderr,
    new RegExp(`pack-installs-alone: @opentui/core doesn't load in the installed zz-host-1\\.0\\.0\\.tgz \\(bun's output is above\\): its native package for this platform \\(${process.platform}-${process.arch}\\) is missing or doesn't load\\.\\n$`),
  );
}, TIMEOUT_MS * 3);

// A child that ignores SIGTERM and would end on its own only after 90 s, so
// a check that only asked it to stop at its limit would take that long.
const DEAF = `process.on("SIGTERM", () => {});\nawait new Promise((resolve) => setTimeout(resolve, 90_000));\n`;

test("a smoke run that doesn't finish is stopped at its limit, even one that ignores SIGTERM, and the limit must be a number", async () => {
  const start = Date.now();
  const slow = await check(standIn({}, `${HOST}${DEAF}`), { PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS: "2000" });
  assert.ok(Date.now() - start < 60_000, `took ${Date.now() - start} ms`);
  assert.equal(slow.code, 1);
  assert.match(slow.stderr, /didn't finish within 2 s \(its output is above\)\.\n$/);
  for (const value of ["", "2m", "0"]) {
    const bad = await check(standIn({}), { PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS: value });
    assert.equal(bad.code, 1);
    assert.equal(bad.stderr, `pack-installs-alone: PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS is '${value}', not a whole number of milliseconds.\n`);
  }
}, TIMEOUT_MS * 2);

test("an install that fails once and then succeeds passes on its second attempt", async () => {
  const blip = npmShim(`if (args[0] === "install" && !fs.existsSync(bin + "/failed")) { fs.writeFileSync(bin + "/failed", ""); console.error("zz: registry blip"); process.exit(1); }\npass();`);
  const result = await check(standIn({}), withPath(blip));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /zz: registry blip\n(?:.*\n)*pack-installs-alone: the install failed \(attempt 1 of 3\); trying again\./);
  assert.doesNotMatch(result.stderr, /attempt 2 of 3/);
  assert.match(result.stdout, /installs on its own with npm /);
}, TIMEOUT_MS * 2);

test("an install that runs out of time, even one that ignores SIGTERM, fails at once, saying so, without another attempt", async () => {
  const slow = npmShim(`if (args[0] === "install") { process.on("SIGTERM", () => {}); setTimeout(() => {}, 90_000); }\nelse pass();`);
  const start = Date.now();
  // The real npm pack runs under this limit too, so it leaves pack room on a
  // loaded runner.
  const result = await check(standIn({}), { ...withPath(slow), PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS: "10000" });
  assert.ok(Date.now() - start < 60_000, `took ${Date.now() - start} ms`);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /pack-installs-alone: the install of zz-host-1\.0\.0\.tgz didn't finish within 10 s\.\n$/);
  assert.doesNotMatch(result.stderr, /attempt 1 of 3/);
}, TIMEOUT_MS * 2);

test("npm pack that runs out of the install's time, even ignoring SIGTERM, fails, saying so", async () => {
  const slow = npmShim(`if (args[0] === "pack") { process.on("SIGTERM", () => {}); setTimeout(() => {}, 90_000); }\nelse pass();`);
  const start = Date.now();
  const result = await check(standIn({}), { ...withPath(slow), PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS: "2000" });
  assert.ok(Date.now() - start < 60_000, `took ${Date.now() - start} ms`);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /pack-installs-alone: npm pack didn't finish within 2 s\.\n$/);
}, TIMEOUT_MS * 2);

test("npm pack that fails, or prints anything but one record with a filename and its files, fails by name", async () => {
  const failing = npmShim(`if (args[0] === "pack") { console.error("zz: pack failed"); process.exit(1); }\npass();`);
  const failed = await check(standIn({}), withPath(failing));
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /zz: pack failed\n(?:.*\n)*pack-installs-alone: npm pack failed \(its output is above\)\.\n$/);
  for (const out of ["[]", "{}", "not json", '[{"name":"zz"}]', '[{"name":"zz","filename":"zz-host-1.0.0.tgz"}]']) {
    const odd = npmShim(`if (args[0] === "pack") { process.stdout.write(${JSON.stringify(out)}); process.exit(0); }\npass();`);
    const result = await check(standIn({}), withPath(odd));
    assert.equal(result.code, 1, out);
    assert.match(result.stderr, /pack-installs-alone: npm pack --json didn't print one record with a filename and its files \(its output is above\)\.\n$/, out);
  }
}, TIMEOUT_MS * 3);

test("no npm on PATH fails by name", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pack-installs-alone-path-"));
  made.push(empty);
  const result = await check(standIn({}), { PATH: empty });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "pack-installs-alone: couldn't run npm: it isn't on PATH.\n");
}, TIMEOUT_MS);
