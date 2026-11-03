// A copy of agent-framework's scripts/release-holds.mjs
// (https://github.com/anima-research/agent-framework), taken from commit
// 9c5e4e3 (pull request #347), and the same apart from this opening comment.
// A change to the check lands there first, with its tests, and is then
// ported here with this commit updated; this repository tests only its own
// wiring (test/release-holds.test.ts).
//
// Runs as npm's `preversion` lifecycle hook (see package.json), before
// `npm version` bumps anything; as `prepublishOnly`, before `npm publish`;
// and in the publish workflow for a pushed tag: in its build job, and in
// each of its two releasing jobs.
// Stops the release while the repository has an open issue labelled
// `release-hold`: someone found that releasing `main` as it stands would harm
// whoever runs it, and the issue says what has to happen first.
//
// The repository is the GitHub repository package.json names, as a URL or in
// npm's shorthand, so a fork or a copy asks the package's home;
// GITHUB_REPOSITORY (as in GitHub Actions) is used only when package.json
// names none (no repository field, or a blank one). A token in GH_TOKEN or GITHUB_TOKEN is sent when present; the
// issues of a public repository read without one. If the holds can't be read,
// the release stops too, since an open hold can't be ruled out.
import { readFileSync, writeSync } from "node:fs";

const LABEL = "release-hold";
const PAGE = 100;
const MAX_PAGES = 50;

function fail(message) {
  // Written synchronously, so a piped stderr has the whole message before
  // the exit.
  writeSync(2, `${message}\n`);
  process.exit(1);
}

/** owner/repo from package.json's repository field: a github.com URL, or
 *  npm's shorthand (github:owner/repo, or owner/repo alone). A URL can go on
 *  past the repository (a path, such as a monorepo's /tree/main/pkg, a query
 *  or a fragment), and the shorthand can name a ref after `#`. */
function githubRepository(field) {
  const value = typeof field === "string" ? field : field?.url;
  if (typeof value !== "string" || value.trim() === "") return {};
  const url = /github\.com[/:]([^/#?\s]+)\/([^/#?\s]+?)(?:\.git)?(?:[/#?].*)?$/.exec(value);
  if (url) return { repo: `${url[1]}/${url[2]}` };
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#.*)?$/.exec(value);
  if (shorthand) return { repo: `${shorthand[1]}/${shorthand[2]}` };
  return { unreadable: value };
}

/** The repository to ask, and where it was named, for a message that has to
 *  send a maintainer to the setting that named it. */
function repository() {
  const fromEnvironment = { repo: process.env.GITHUB_REPOSITORY, namedBy: "GITHUB_REPOSITORY" };
  let pkg;
  try {
    pkg = JSON.parse(readFileSync("package.json", "utf8"));
  } catch (error) {
    if (fromEnvironment.repo) return fromEnvironment;
    fail(`release-holds: can't read package.json (${error.message}), and GITHUB_REPOSITORY is unset`);
  }
  const named = githubRepository(pkg.repository);
  if (named.repo) return { repo: named.repo, namedBy: "package.json's repository field" };
  if (named.unreadable) {
    fail(`release-holds: package.json's repository field (${named.unreadable}) names no GitHub repository this check can ask`);
  }
  if (fromEnvironment.repo) return fromEnvironment;
  fail("release-holds: package.json names no repository, and GITHUB_REPOSITORY is unset");
}

const { repo, namedBy } = repository();
const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const where = `https://github.com/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3A${LABEL}`;
// How to go on after a stop, for where it ran: npm version's hook, wherever
// it runs, comes before any tag; in the workflow, the tag is there to re-run.
const lifecycle = process.env.npm_lifecycle_event;
const rerun = lifecycle === "preversion"
  ? "run npm version again"
  : process.env.GITHUB_ACTIONS === "true"
    ? "re-run this workflow for the tag"
    : lifecycle === "prepublishOnly"
      ? "run npm publish again"
      : "run this again";

/** What a maintainer can do about an answer other than the list. */
function refusal(status) {
  if (status === 401) {
    return "GitHub doesn't accept the token in GH_TOKEN or GITHUB_TOKEN; replace it, or unset it for a public repository";
  }
  if (status === 403 || status === 429) {
    return token
      ? "the token in GH_TOKEN or GITHUB_TOKEN can't read this repository's issues, or its rate limit is spent; use one that can, or try again later"
      : "this address has used up GitHub's rate limit for requests without a token; set GH_TOKEN to a token that can read the repository's issues, or try again later";
  }
  if (status === 404) {
    return token
      ? `no repository ${repo} is visible to the token in GH_TOKEN or GITHUB_TOKEN; check ${namedBy} and the token's access`
      : `no repository ${repo} is visible without a token; check ${namedBy}, or set GH_TOKEN if the repository is private`;
  }
  if (status === 410) {
    return `issues are turned off for ${repo}, so no hold can be filed or read there; turn them on, or point ${namedBy} at the repository that tracks them`;
  }
  if (status >= 500) return `GitHub had an error; ${rerun} once it answers normally`;
  return "this check doesn't know that answer; see what GitHub shows";
}

/** One page of the repository's open issues and pull requests with the label. */
async function page(number) {
  let response;
  try {
    response = await fetch(
      `${api}/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=${PAGE}&page=${number}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    const why = error.name === "TimeoutError"
      ? "no answer within 30 s"
      : error.cause?.code ?? error.cause?.message ?? error.message;
    fail(`release-holds: couldn't reach GitHub to read the release holds (${why}). Check ${where}, and ${rerun} once GitHub can be reached.`);
  }
  if (!response.ok) {
    fail(`release-holds: GitHub answered ${`${response.status} ${response.statusText}`.trim()} when asked for the release holds: ${refusal(response.status)}. ${where}`);
  }
  let items;
  try {
    items = await response.json();
  } catch (error) {
    fail(`release-holds: couldn't read GitHub's answer (${error.name === "TimeoutError" ? "no answer within 30 s" : error.message}). Check ${where}, and ${rerun}.`);
  }
  if (!Array.isArray(items)) {
    fail(`release-holds: GitHub's answer wasn't a list of issues. Check ${where}, and ${rerun}.`);
  }
  return items;
}

// The issues endpoint lists pull requests too. A hold is an issue: a pull
// request isn't on main until it merges.
// Only a page after the last it reads that holds something is past the
// limit: a full last page leads to one more read, which may be empty.
const holds = [];
for (let number = 1; ; number++) {
  const items = await page(number);
  if (number > MAX_PAGES && items.length > 0) {
    fail(`release-holds: more than ${MAX_PAGES * PAGE} open items are labelled ${LABEL} in ${repo}, more than this check reads. ${where}`);
  }
  holds.push(...items.filter((item) => !item.pull_request));
  if (items.length < PAGE) break;
}

if (holds.length > 0) {
  fail(
    [
      `Release held: ${holds.length === 1 ? "an open issue is" : `${holds.length} open issues are`} labelled ${LABEL} in ${repo} (named by ${namedBy}).`,
      ...holds.map((hold) => `  #${hold.number} ${hold.title}`),
      `Resolve each one, or close it if it no longer applies, then ${rerun}. ${where}`,
    ].join("\n"),
  );
}
