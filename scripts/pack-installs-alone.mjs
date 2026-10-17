// Packs connectome-host as `npm publish` packs it, with the Web UI this tree
// has built (package.json's `files` lists dist/web), installs the tarball
// alone into an empty directory with its dependencies from the registry, and
// runs it there under bun. The install runs no install scripts, as npm 12
// and bun install by default, so a dependency that needs its install script
// to work fails here as it would for them. npm 10 and 11 run install
// scripts: the package's own postinstall builds the Web UI only in a
// checkout, where web/ is, and no dependency in package-lock.json has one.
// Build the Web UI first (`npm run build:web:ci`). It checks:
//   1. the package carries the Web UI, dist/web/index.html and every local
//      file its quoted src and href attributes name, as vite writes them,
//      and tsconfig.json, with which a consumer typechecks the TypeScript
//      source the package ships, as connectome-smoke's published lane does;
//   2. `bun build` resolves src/index.ts's static imports, and its dynamic
//      ones with a literal specifier, in the installed tree, on paths a run
//      doesn't reach too (a recipe extension, loaded by a computed path, isn't
//      among them);
//   3. @opentui/core loads with its native package for this platform, which
//      it imports by a computed path that `bun build` can't follow;
//   4. the README's offline smoke run, recipes/mock-test.json in batch mode,
//      with the Web UI off and membrane's mock adapter replying from a queue,
//      so no credentials and no provider call. It must exit 0, taking the
//      message it was sent and then printing the queued reply, which carries
//      a nonce of this run.
// A file missing from the package, or a dependency only devDependencies
// supplied, then fails here, before the release is published, and not for
// whoever installs it. The publish workflow runs it in a job of its own,
// without the publish credential, since building the Web UI runs its
// dependencies' install scripts, and publishes the Web UI that job built;
// to check by hand, build the Web UI and run it from the repository root,
// for example before `git push --follow-tags`. npm pack packs the working
// tree, so it warns when that differs from HEAD, where the publish workflow
// packs a clean checkout; prepack's scripts/pack-contents.mjs stops a pack
// that would carry a file git ignores.
// A failed install is tried again, three attempts in all,
// PACK_INSTALLS_ALONE_RETRY_DELAY_MS apart (default 15000), to get past a
// registry blip; one that runs out of time isn't.
// PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS and
// PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS set the install's and the smoke run's
// limits in milliseconds (defaults 900000 and 120000); npm pack has the
// install's. A child that outlives its limit is killed, not asked to stop:
// one that handles SIGTERM, as a dependency's new release could, would keep
// running past it.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ENTRY = "src/index.ts";
const SMOKE_RECIPE = "recipes/mock-test.json";
const SMOKE_MESSAGE = "pack-installs-alone: hello";
const WEB_UI = "dist/web/index.html";
// Loads its native package for this platform by a computed import.
const NATIVE = "@opentui/core";
const INSTALL_ATTEMPTS = 3;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

class CheckError extends Error {}

/** A whole number of milliseconds from the environment, or `fallback`. */
function millis(name, fallback, zeroAllowed = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!(zeroAllowed ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)) {
    throw new CheckError(`${name} is '${value}', not a whole number of milliseconds.`);
  }
  return Number(value);
}

/** The working tree's changes from HEAD, as git lists them, or none outside
 *  a git checkout. */
function changesFromHead() {
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  if (status.status !== 0) return [];
  return status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3));
}

/** The local files a built index.html names in its quoted src and href
 *  attributes, as vite writes them, as paths under its own directory:
 *  URLs with a scheme or a host, and anchors, aside. */
function webAssets(html) {
  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]*)/gi)].map((match) => match[1]);
  return [...new Set(refs.filter((ref) => ref !== "" && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)).map((ref) => ref.replace(/^\.?\//, "")))];
}

/** Up to five paths, for a message. */
function some(paths) {
  return `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", …" : ""}`;
}

class TimeoutError extends CheckError {}

/** Runs a command, its output going to ours. A failure throws `message`,
 *  and running out of time says that `what` didn't finish. */
function run(file, args, options, what, message) {
  try {
    execFileSync(file, args, { stdio: ["ignore", "inherit", "inherit"], killSignal: "SIGKILL", ...options });
  } catch (error) {
    if (error?.code === "ENOENT") throw new CheckError(`couldn't run ${file}: it isn't on PATH.`);
    if (error?.code === "ETIMEDOUT") throw new TimeoutError(`${what} didn't finish within ${options.timeout / 1000} s.`);
    throw new CheckError(message);
  }
}

function main() {
  const smokeTimeoutMs = millis("PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS", 120_000);
  const installTimeoutMs = millis("PACK_INSTALLS_ALONE_INSTALL_TIMEOUT_MS", 15 * 60_000);
  const retryDelayMs = millis("PACK_INSTALLS_ALONE_RETRY_DELAY_MS", 15_000, true);
  const changed = changesFromHead();
  if (changed.length > 0) {
    console.error(
      `pack-installs-alone: warning: the working tree differs from HEAD in ${changed.length} ` +
        `${changed.length === 1 ? "path" : "paths"} (${some(changed)}). ` +
        "npm pack packs the working tree, so this run checks whichever of them the package includes, where the " +
        "publish workflow packs a clean checkout.",
    );
  }
  if (!existsSync(WEB_UI)) {
    throw new CheckError(
      `${WEB_UI} isn't in this tree: build the Web UI first (npm run build:web:ci), since the package carries it built.`,
    );
  }
  let npmVersion;
  try {
    npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  } catch (error) {
    if (error?.code === "ENOENT") throw new CheckError("couldn't run npm: it isn't on PATH.");
    throw new CheckError("npm --version failed (its output is above).");
  }
  const work = mkdtempSync(join(tmpdir(), "pack-installs-alone-"));
  try {
    let out = "";
    try {
      // Lifecycle scripts' output would land ahead of the JSON in the
      // foreground, so they run in the background.
      out = execFileSync("npm", ["pack", "--json", "--foreground-scripts=false", "--pack-destination", work], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: MAX_BUFFER,
        timeout: installTimeoutMs,
        killSignal: "SIGKILL",
      });
    } catch (error) {
      if (error?.code === "ENOENT") throw new CheckError("couldn't run npm: it isn't on PATH.");
      process.stderr.write(error?.stdout ?? out);
      if (error?.code === "ETIMEDOUT") throw new CheckError(`npm pack didn't finish within ${installTimeoutMs / 1000} s.`);
      throw new CheckError("npm pack failed (its output is above).");
    }
    // npm 11 prints an array of records, npm 12 an object keyed by name.
    let records;
    try {
      const parsed = JSON.parse(out);
      records = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
    } catch {
      records = [];
    }
    if (records.length !== 1 || typeof records[0]?.filename !== "string" || !Array.isArray(records[0]?.files)) {
      process.stderr.write(out);
      throw new CheckError("npm pack --json didn't print one record with a filename and its files (its output is above).");
    }
    const packed = records[0];
    const files = packed.files.map((file) => file.path);
    const tarball = join(work, packed.filename);
    const dir = join(work, "install");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pack-installs-alone", private: true }));
    for (let attempt = 1; ; attempt++) {
      try {
        run(
          "npm",
          ["install", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts", tarball],
          { cwd: dir, timeout: installTimeoutMs },
          `the install of ${packed.filename}`,
          `${packed.filename} didn't install on its own into an empty directory, in ${INSTALL_ATTEMPTS} attempts ` +
            "(npm's output is above). A dependency that isn't on the registry does that, or a registry or network " +
            "error that outlasts the attempts.",
        );
        break;
      } catch (error) {
        // Running out of time isn't a blip: retried, it would leave npm's
        // children writing into the tree the next attempt starts from.
        const final = !(error instanceof CheckError) || error instanceof TimeoutError;
        if (final || attempt === INSTALL_ATTEMPTS) throw error;
        console.error(`pack-installs-alone: the install failed (attempt ${attempt} of ${INSTALL_ATTEMPTS}); trying again.`);
        rmSync(join(dir, "node_modules"), { recursive: true, force: true });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs);
      }
    }
    const installed = join(dir, "node_modules", ...packed.name.split("/"));

    if (!existsSync(join(installed, WEB_UI))) {
      throw new CheckError(
        `the installed ${packed.filename} has no ${WEB_UI}, though this tree has it: package.json's files must list ` +
          `${dirname(WEB_UI)}, so that npm 12 and bun installs, which run no install scripts, get the Web UI.`,
      );
    }
    const unshipped = webAssets(readFileSync(join(installed, WEB_UI), "utf8")).filter(
      (asset) => !existsSync(join(installed, dirname(WEB_UI), asset)),
    );
    if (unshipped.length > 0) {
      throw new CheckError(
        `the installed ${packed.filename}'s ${WEB_UI} names ${some(unshipped)}, which ${unshipped.length === 1 ? "isn't" : "aren't"} ` +
          `in the package: package.json's files must list all of ${dirname(WEB_UI)}, or the Web UI is a blank page.`,
      );
    }
    if (!existsSync(join(installed, "tsconfig.json"))) {
      throw new CheckError(
        `the installed ${packed.filename} has no tsconfig.json: package.json's files must list it, since the package ships ` +
          "its TypeScript source and a consumer typechecks that with it, as connectome-smoke's published lane does.",
      );
    }

    run(
      "bun",
      ["build", "--target=bun", join(installed, ENTRY), "--outdir", join(work, "bundle")],
      { cwd: dir, stdio: ["ignore", "ignore", "inherit"], timeout: BUILD_TIMEOUT_MS },
      `bun build of the installed ${ENTRY}`,
      `an import of ${ENTRY} doesn't resolve in the installed ${packed.filename} (bun's output is above). ` +
        "A file missing from the package, or a dependency only devDependencies supplied, does that.",
    );

    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    const native = [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies].some((deps) => deps?.[NATIVE] !== undefined);
    if (native) {
      run(
        "bun",
        ["-e", `await import(${JSON.stringify(NATIVE)})`],
        { cwd: installed, stdio: ["ignore", "ignore", "inherit"], timeout: BUILD_TIMEOUT_MS },
        `loading ${NATIVE}`,
        `${NATIVE} doesn't load in the installed ${packed.filename} (bun's output is above): its native package ` +
          `for this platform (${process.platform}-${process.arch}) is missing or doesn't load.`,
      );
    }

    // The smoke run's recipe, with the Web UI off (batch mode keeps a Web UI
    // serving after the run, and nothing here would end it), and the mock
    // agent's reply queued, with a nonce, so the check reads this run's reply.
    const reply = `pack-installs-alone: reply ${randomBytes(4).toString("hex")}`;
    let recipe;
    try {
      recipe = JSON.parse(readFileSync(join(installed, SMOKE_RECIPE), "utf8"));
    } catch (error) {
      throw new CheckError(`the installed ${packed.filename} has no readable ${SMOKE_RECIPE}: ${error.message}.`);
    }
    recipe.modules = { ...recipe.modules, webui: false };
    recipe.agent = { ...recipe.agent, mock: { echoMode: false, responseQueue: [reply] } };
    const smokeRecipe = join(work, "smoke-recipe.json");
    writeFileSync(smokeRecipe, JSON.stringify(recipe));
    const smoke = spawnSync("bun", [join(installed, ENTRY), smokeRecipe], {
      cwd: dir,
      input: `${SMOKE_MESSAGE}\n`,
      encoding: "utf8",
      timeout: smokeTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, DATA_DIR: join(work, "data") },
    });
    process.stdout.write(smoke.stdout ?? "");
    process.stderr.write(smoke.stderr ?? "");
    const smokeRun = `the offline smoke run (${SMOKE_RECIPE} in batch mode, Web UI off) of the installed ${packed.filename}`;
    if (smoke.error?.code === "ETIMEDOUT") {
      throw new CheckError(`${smokeRun} didn't finish within ${smokeTimeoutMs / 1000} s (its output is above).`);
    }
    if (smoke.error?.code === "ENOENT") throw new CheckError("couldn't run bun: it isn't on PATH.");
    if (smoke.error) throw new CheckError(`${smokeRun} failed: ${smoke.error.message}.`);
    if (smoke.status !== 0) {
      throw new CheckError(`${smokeRun} exited ${smoke.status ?? `on ${smoke.signal}`} (its output is above).`);
    }
    // Batch mode prints each line it takes as '> line', and the agent's reply
    // after it.
    const lines = (smoke.stdout ?? "").split("\n");
    const taken = lines.indexOf(`> ${SMOKE_MESSAGE}`);
    if (taken === -1 || !lines.slice(taken + 1).some((line) => line.trim() === reply)) {
      throw new CheckError(
        `${smokeRun} exited 0, but the mock agent's queued reply, '${reply}', didn't follow '> ${SMOKE_MESSAGE}' ` +
          "(its output is above).",
      );
    }
    console.log(
      `${packed.filename} (${files.length} files) installs on its own with npm ${npmVersion}, running no install ` +
        `scripts; it carries the Web UI and tsconfig.json, ${ENTRY}'s imports resolve` +
        `${native ? `, ${NATIVE} loads` : ""}, and the offline smoke run answered.`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  if (!(error instanceof CheckError)) throw error;
  console.error(`pack-installs-alone: ${error.message}`);
  process.exitCode = 1;
}
