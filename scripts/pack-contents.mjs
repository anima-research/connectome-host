// Run by prepack, which `npm pack` and `npm publish` run before anything is
// packed, as `bun pm pack` and `bun publish` do, unless scripts are off
// (--ignore-scripts, or ignore-scripts in an npmrc, which skips
// prepublishOnly's release holds too). It refuses a pack without the built
// Web UI (dist/web/index.html), and one that would carry a file git ignores,
// the built Web UI aside: package.json's files takes what it lists whole, so a
// local file there, such as a recipe of your own (my-recipe.json) or a data/
// directory, would ship from a working tree, where the publish job's clean
// checkout has none. git decides what's ignored, from .gitignore,
// .git/info/exclude and your own excludes file, so this keeps no list of its
// own. In a git checkout, when git can't say, the pack stops. Outside one,
// such as a copy of the files made to run the checks elsewhere, it says it
// can't tell and lets a pack through, since the pack check runs in such
// copies; a copy that holds local files packs them, with that warning. An
// npm publish there stops, since its warning would come once the tarball is
// public; bun's publish tells its scripts it's a pack, so it gets the warning.
// `npm publish` of a tarball runs no scripts, but the tarball's `npm pack` ran
// this. Each refusal exits 1 saying what to do.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WEB_UI = "dist/web/index.html";
const MAX_BUFFER = 64 * 1024 * 1024;

/** npm: the one running this, when npm runs it. */
function npm(args) {
  const cli = process.env.npm_execpath;
  return cli && /npm-cli\.c?js$/.test(cli) ? [process.execPath, [cli, ...args]] : ["npm", args];
}

/** The .git of the checkout this directory is in, or null outside one. */
function checkout(dir) {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return join(at, ".git");
    if (dirname(at) === at) return null;
  }
}

function main() {
  if (!existsSync(WEB_UI)) {
    console.error(
      `pack-contents: ${WEB_UI} is missing: the package carries the Web UI built. Build it (npm run build:web:ci) ` +
        "before packing; in the publish workflow it comes from the pack-check job's web-ui artifact.",
    );
    return 1;
  }
  let paths;
  try {
    // --ignore-scripts, so this pack doesn't run prepack, and this, again.
    const [file, args] = npm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
    const parsed = JSON.parse(execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: MAX_BUFFER }));
    // npm 11 prints an array of records, npm 12 an object keyed by name.
    paths = (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]).files.map((entry) => entry.path);
  } catch (error) {
    console.error(
      `pack-contents: npm pack --dry-run couldn't list what the package would carry ` +
        `(${error instanceof Error ? error.message : String(error)}): fix what npm reports and pack again.`,
    );
    return 1;
  }
  const ignores = spawnSync("git", ["check-ignore", "--stdin", "-z"], { input: paths.join("\0"), encoding: "utf8", maxBuffer: MAX_BUFFER });
  // 0: some are ignored; 1: none is; anything else: git couldn't say.
  if (ignores.status !== 0 && ignores.status !== 1) {
    // git's own words when it gave any: outside a checkout it can exit
    // before it reads the paths, so the write fails too (EPIPE).
    const why = (`${ignores.stderr ?? ""}`.trim() || ignores.error?.message || `exit ${ignores.status}`).replace(/\s+/g, " ");
    const dotGit = checkout(process.cwd());
    if (dotGit !== null) {
      console.error(
        `pack-contents: git couldn't say which of the files to pack it ignores (${why}). This is a git checkout ` +
          `(${dotGit}), where a local file could ship, so the pack stops: fix what git reports and pack again.`,
      );
      return 1;
    }
    // npm names the command it runs this for; bun's publish names itself a
    // pack, so it gets a pack's warning.
    if (process.env.npm_command === "publish") {
      console.error(
        `pack-contents: this is a publish from a tree with no .git above it, so git couldn't say which of the files to pack ` +
          `it ignores (${why}), and a local file could ship: publish from a git checkout.`,
      );
      return 1;
    }
    console.error(`pack-contents: warning: this isn't a git checkout, so git couldn't say which of the files to pack it ignores (${why}), and they weren't checked for local files.`);
    return 0;
  }
  const ignored = ignores.status === 0 ? ignores.stdout.split("\0").filter((path) => path !== "" && !path.startsWith("dist/web/")) : [];
  if (ignored.length > 0) {
    console.error(
      `pack-contents: package.json's files would pack ${ignored.length === 1 ? "a file" : `${ignored.length} files`} that git ignores:\n` +
        `${ignored.map((path) => `  ${path}\n`).join("")}` +
        `Move ${ignored.length === 1 ? "it" : "them"} out of the tree, or pack from a clean checkout.`,
    );
    return 1;
  }
  return 0;
}

process.exitCode = main();
