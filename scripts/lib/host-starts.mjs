import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENTRY = "src/index.ts";
const SMOKE_RECIPE = "recipes/mock-test.json";
const SMOKE_MESSAGE = "pack-installs-alone: hello";
// Loads its native package for this platform by a computed import.
const NATIVE = "@opentui/core";
const LOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export class CheckError extends Error {}

export class TimeoutError extends CheckError {}

export function run(file, args, options, what, message) {
  try {
    execFileSync(file, args, { stdio: ["ignore", "inherit", "inherit"], killSignal: "SIGKILL", ...options });
  } catch (error) {
    if (error?.code === "ENOENT") throw new CheckError(`couldn't run ${file}: it isn't on PATH.`);
    if (error?.code === "ETIMEDOUT") throw new TimeoutError(`${what} didn't finish within ${options.timeout / 1000} s.`);
    throw new CheckError(message);
  }
}

export function hostStarts({ root, cwd, work, subject, smokeTimeoutMs }) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const native = [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies].some((deps) => deps?.[NATIVE] !== undefined);
  if (native) {
    run(
      "bun",
      ["-e", `(await import(${JSON.stringify(NATIVE)})).resolveRenderLib()`],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"], timeout: LOAD_TIMEOUT_MS },
      `loading ${NATIVE}`,
      `${NATIVE} doesn't load in ${subject} (bun's output is above): its native package ` +
        `for this platform (${process.platform}-${process.arch}) is missing or doesn't load.`,
    );
  }

  const reply = `pack-installs-alone: reply ${randomBytes(4).toString("hex")}`;
  let recipe;
  try {
    recipe = JSON.parse(readFileSync(join(root, SMOKE_RECIPE), "utf8"));
  } catch (error) {
    throw new CheckError(`${subject} has no readable ${SMOKE_RECIPE}: ${error.message}.`);
  }
  recipe.modules = { ...recipe.modules, webui: false };
  recipe.agent = { ...recipe.agent, mock: { echoMode: false, responseQueue: [reply] } };
  const smokeRecipe = join(work, "smoke-recipe.json");
  writeFileSync(smokeRecipe, JSON.stringify(recipe));
  const smoke = spawnSync("bun", [join(root, ENTRY), smokeRecipe], {
    cwd,
    input: `${SMOKE_MESSAGE}\n`,
    encoding: "utf8",
    timeout: smokeTimeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, DATA_DIR: join(work, "data") },
  });
  process.stdout.write(smoke.stdout ?? "");
  process.stderr.write(smoke.stderr ?? "");
  const smokeRun = `the offline smoke run (${SMOKE_RECIPE} in batch mode, Web UI off) of ${subject}`;
  if (smoke.error?.code === "ETIMEDOUT") {
    throw new CheckError(`${smokeRun} didn't finish within ${smokeTimeoutMs / 1000} s (its output is above).`);
  }
  if (smoke.error?.code === "ENOENT") throw new CheckError("couldn't run bun: it isn't on PATH.");
  if (smoke.error) throw new CheckError(`${smokeRun} failed: ${smoke.error.message}.`);
  if (smoke.status !== 0) {
    throw new CheckError(`${smokeRun} exited ${smoke.status ?? `on ${smoke.signal}`} (its output is above).`);
  }
  const lines = (smoke.stdout ?? "").split("\n");
  const taken = lines.indexOf(`> ${SMOKE_MESSAGE}`);
  if (taken === -1 || !lines.slice(taken + 1).some((line) => line.trim() === reply)) {
    throw new CheckError(
      `${smokeRun} exited 0, but the mock agent's queued reply, '${reply}', didn't follow '> ${SMOKE_MESSAGE}' ` +
        "(its output is above).",
    );
  }
  return { native };
}
