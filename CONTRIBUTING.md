# Contributing to connectome-host

connectome-host is part of the Connectome ecosystem
([agent-framework](https://github.com/anima-research/agent-framework),
[membrane](https://github.com/antra-tess/membrane),
[context-manager](https://github.com/anima-research/context-manager),
[chronicle](https://github.com/anima-research/chronicle)). These conventions
describe how work actually lands here — they codify existing practice rather
than aspiration. When in doubt, recent merged PRs are the best reference.

Everything below applies to every change however it lands — external PR or
maintainer direct push — and to human and AI authors identically. There is
no separate rulebook for either.

## How changes land

- External contributions come as PRs against `main`, from a fork or a repo
  branch. Maintainers also land small changes directly on `main`; don't be
  surprised by history that never saw a PR.
- Branch names: `feat/<kebab-case>`, `fix/<kebab-case>`, `docs/`, `chore/`.
  Including the issue number is welcome (`fix/43-scope-module-injections`).
- PRs are merged as **true merge commits** — no squash, no rebase-merge.
  Because nothing is squashed, keep individual commits coherent.
- To update a stale branch, rebase onto `main` or merge `main` in; both are
  accepted.
- Stacked PRs and cross-repo companion PRs are fine, but **declare them** in
  the body with merge-order guidance ("stacked on #7 — review that first";
  "safe to merge in either order because …").

## What a PR should contain

Body shape (the PR template mirrors this): **Problem / Changes / Tests**,
plus, when applicable, **Not verified**, **Out of scope**, and
**Companion PRs**. The conventions that matter:

- **Evidence over assertion.** State the test baseline numerically:
  "`bun test`: N pass / M fail, failure count identical to `main` baseline."
  A claim like "all tests pass" without the count will be re-verified anyway,
  so save the reviewer the trip.
- **Say what you did NOT verify.** An honest "not exercised end-to-end
  against a live Zulip" is respected; a silent gap that review uncovers is
  not.
- **Tests accompany behavior changes.** Review scrutinizes test substance,
  not mere presence — a test that can't fail on the unfixed code will be
  called out.
- **Changelog fragment** in `changelog.d/` for anything behavior-affecting
  (see below).

Conventional-commit-style titles (`feat(recipe): …`, `fix(subagent): …`) are
the house default; plain descriptive titles are accepted.

## Review process — what to expect

- Review arrives as **ordinary PR comments**, not GitHub review approvals —
  the comment thread is the gate. Reviews are frequently AI-generated and
  explicitly labeled as such, with a severity verdict and itemized findings.
- The reviewer will typically **run your branch** (typecheck, test suite,
  loading a recipe) and paste transcripts. Claims are checked, not trusted.
- **Greptile** doesn't review new PRs. It reviews only PRs labelled
  `greptile` (`.greptile/config.json`), so don't add that label to a new PR.
- Respond by pushing fix commits and replying per finding — "Addressed in
  `<sha>`" — rather than force-pushing a rewritten branch. A re-review then
  flips the verdict.
- Maintainers may push small review fixes **directly to your branch** to keep
  things moving. Say so in the PR body if you'd rather they didn't.
- PRs are never closed silently: a closed PR gets a one-line disposition
  comment (usually supersession by another PR).

## AI-assisted contributions

AI-written code is the norm in this ecosystem, welcome from everyone, and
held to exactly the same evidence standards as anything else. Declare it the
way we do:

- the `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
  footer (or equivalent for your tooling) in the PR body, and
- a `Co-Authored-By:` trailer naming the model in commits.

What earns an automated contribution a changes-requested review is not being
AI-generated — it's arriving without the suite having been run, with tests
that don't fail on unfixed code, or with claims the branch itself disproves.

## Changelog

Changelog entries land as **fragment files** in
[`changelog.d/`](changelog.d/) — one file per change — and are folded into
`CHANGELOG.md` (loosely [Keep a Changelog](https://keepachangelog.com/)) at
release time. One file per change is what keeps concurrent work from
conflicting: when every PR edited the same `## Unreleased` section, any PR
that outlived another merge hit a conflict in `CHANGELOG.md`; distinct files
never do.

- **Format:** `changelog.d/<slug>.<breaking|added|changed|fixed>.md`, a flat
  file directly in `changelog.d/`, containing one or more markdown bullets
  (`- …`) written exactly as they should appear in `CHANGELOG.md`:
  continuation lines indent two spaces, nested bullets are fine, headings
  and horizontal rules are refused (even indented — a heading inside a
  fragment would corrupt the section structure). The slug just has to be
  unique among pending fragments and filesystem-safe — the PR number works,
  and so does the branch name with `/` replaced by `-`
  (`100-prose-routing.added.md`, `fix-retry-backoff.fixed.md`). The release
  script scans the directory fail-closed: a subdirectory, an unrecognized
  category suffix, or any other stray file aborts the release rather than
  silently stranding an entry.

- **The fragment lands with the change** — same commit, or at least the same
  PR. This binds direct pushes to `main` just as much as PRs. On PRs, CI
  enforces it softly: touching `src/` without adding a fragment (or editing
  `CHANGELOG.md`) fails the `changelog` check unless the `no-changelog`
  label is applied.
- **What needs an entry:** anything an operator, recipe author, or module
  developer would notice — behavior, config/recipe schema, CLI, tool
  surfaces, defaults. Internal refactors, test-only, and docs-only changes
  don't.
- **Breaking entries are audience-scoped.** Open the bullet by naming who
  needs to act (`- **Recipe authors:** …`) and cover: **who needs to act**,
  **migration**, and **unchanged** (what readers might fear broke but
  didn't). The fleet recipe-path entry in `CHANGELOG.md` is the canonical
  example of the format.
- **Editing `## Unreleased` in `CHANGELOG.md` directly still works** and is
  merged with the fragments at release time — it remains the right place to
  restructure pending entries, and the escape hatch for anything the
  fragment format can't express (e.g. an audience-qualified
  `### Breaking (recipe authors only)` heading, which `breaking` fragments
  will then join). Keep one `## Unreleased` heading — the release script
  refuses more than one, since only the first is ever cut.
- **Releases** (maintainers): `npm version <patch|minor|major>` does the
  whole cut — the `version` hook folds the pending fragments plus any
  entries filed directly under `Unreleased` into `## X.Y.Z — YYYY-MM-DD`
  (subsections emitted in `### Breaking` / `### Added` / `### Changed` /
  `### Fixed` order), deletes the consumed fragments, keeps a fresh empty
  `Unreleased` above, and refuses to release when there is nothing to
  release. It also writes the release's own fields into `package.json` as
  `connectomeRelease`, which npm's full manifest of the version (what
  `npm view` reads) keeps. `breaking` is whether anything is breaking since
  the last final release below it in the changelog: the new section, or any
  section between them, has a Breaking subsection with anything in it, as
  `npm version`'s check of a pending breaking entry reads one.
  `cacheWrite` is whether an update from that last final release changes
  what each resident's requests carry before its newest turn, so that each
  one's next request writes its prompt cache in full. Give it as
  `RELEASE_CACHE_WRITE=yes@<version>` or `no@<version>`, naming the version
  being cut; any other value is refused, and a cut nobody measured leaves it
  unset and records nothing of its cost. When the hook refuses, npm has
  already written the new version into `package.json` and
  `package-lock.json` and leaves it there, so restore both
  (`git checkout package.json package-lock.json`) before running
  `npm version` again.
  Otherwise npm commits and tags. `git push --follow-tags` triggers the
  publish workflow, which refuses a tag with no matching changelog section,
  builds the Web UI and checks in a job of its own that the packed release,
  which carries it in `dist/web`, installs and runs on its own
  (`node scripts/pack-installs-alone.mjs`: the package carries the Web UI
  and `tsconfig.json`, which consumers typecheck its source with; npm
  installs the tarball alone into an empty directory and runs no install
  scripts, as npm 12 and bun install by default; bun resolves
  `src/index.ts`'s static imports there, and its dynamic ones with a
  literal specifier, though not a recipe extension's, which load by a
  computed path, and loads `@opentui/core`; and the offline mock-recipe
  smoke run answers; CI runs it on pull requests
  too, and by hand it runs from the repository root after
  `npm run build:web:ci`, for example before `git push --follow-tags`,
  warning when the working tree differs from `HEAD`, since npm packs the
  working tree), publishes
  `@animalabs/connectome-host` to npm with the Web UI that check built once
  it has passed, and creates the GitHub release with that section as its
  notes. Nothing is installed or built in the publish job, which can mint
  the publish credential. `prepack` refuses to pack a tree without the
  built Web UI, or a pack that would carry a file git ignores outside it,
  such as a local recipe in `recipes/`, so `npm pack` and `npm publish`,
  and bun's, stop there, in the publish job and by hand alike, unless
  scripts are off (`--ignore-scripts`, which skips the release holds
  too). The
  root `postinstall` builds the Web UI only in a checkout, where `web/` is:
  the package doesn't ship `web/`, so on a registry install it does
  nothing. When the check fails on a tag, the
  notes are out and npm isn't. Re-run the failed jobs first: a registry or
  network blip, or a timeout, passes then. If it fails the same way again,
  fix the break, which can be a dependency's new release, and release the
  next patch. The two release jobs are independent: some
  consumers run github-clone checkouts, so release notes must exist even
  when npm publish fails. Both need the build job, so a failed build stops
  both; past it, so do a tag with no changelog section, which neither can
  release, and an open release hold (below), which each checks. Version
  bumps are a maintainer release-time action, not part of feature PRs.
- **Breaking changes.** A dependent's caret range takes the later
  versions of its line (0.10.x before 1.0, 1.x from 1.0, and 0.0.z alone),
  so a breaking change released as a patch reaches each dependent whose
  range takes it at its next fresh install. Before 1.0, a breaking change
  goes out in a new minor version (0.10.x to 0.11.0), and from 1.0 in a
  new major. File it as breaking, as a `breaking` fragment or under a
  `### Breaking` subsection of `Unreleased`: that is what `npm version`
  reads. While such an entry is pending, `npm version` refuses a version
  that doesn't open a line no release has reached, before it bumps or
  writes anything, and says where each entry is filed and the bump to run
  instead. A prerelease counts as the release it leads to, so one in the
  current line is refused too. One that opens the next line (a preminor
  before 1.0, a premajor from 1.0) isn't, and nor is any later version of
  that line. A version below the current line is refused as well. bun's
  `bun pm version` runs this check without giving it either version, so
  while a breaking entry is pending it refuses every bump there: release
  with `npm version`. npm's `--ignore-scripts` skips this check, but it
  also skips the fold, and the publish workflow refuses a tag whose
  version has no changelog section.
- **Release holds.** When releasing `main` as it stands would harm
  someone running it, open an issue that says what has to happen first
  and label it `release-hold`, or ask a maintainer to label it. Close it
  once that's happened, or if it no longer applies. When what has to
  happen is a fix that this package itself must release, close the hold
  once the fix is merged, then release. While one is open, `npm version`
  stops before it bumps anything, `npm publish` refuses (bun's
  `bun pm version` and `bun publish` run the same hooks, and stop too), and
  the publish workflow refuses both its npm publish and its GitHub release
  notes, each checking when it runs. The check also stops a release when it
  can't read the holds from GitHub, and says why. Closing the hold is the
  way past it. npm's `--ignore-scripts` skips the check, but on `npm version`
  it skips the changelog fold too, so the tag lands without its changelog
  section and the publish workflow's changelog check fails it. Publishing a
  tarball made earlier with `npm pack` runs no lifecycle script, so no check
  sees it. A hold stops releases, not merges, so when the hazard is in an
  open pull request, say so on that pull request, naming what has to happen
  first: its comment thread is the gate (see Review process).

## Building and testing

```bash
bun install
bun test            # test suite
bunx tsc --noEmit   # typecheck the host's source (src/)
(cd web && bunx tsc --noEmit)   # typecheck the web app
bun src/index.ts    # run (generic assistant)
```

CI (`ci.yml`) runs on every pull request and every push to `main`, on ubuntu
and macOS. Both install the root and the web app with a strict lockfile
(`npm ci`), which fails when a lock doesn't match its `package.json` or
lacks that platform's packages, and build the web app; the test suite runs
on ubuntu only. A typecheck job checks the types of the host's source
(`src/`; `test/` and `scripts/` aren't checked) and of the web app
(`tsc --noEmit`), which nothing else does: bun runs TypeScript without
checking its types, and `vite build` doesn't check them either. If you
touched `web/`
dependencies, regenerate the npm lock with `npm run relock:web`, so it
carries both platforms' native binaries. It resolves every web dependency
afresh, so review the lock's diff. Then regenerate `web/bun.lock` from it:
delete `web/bun.lock` and run `bun install --lockfile-only` in `web/`, which
builds Bun's lock from the npm lock, so both pin the same versions.

The root has two lockfiles as well: `bun.lock`, which `bun install` reads
when a checkout is installed as the README says, and `package-lock.json`,
which npm reads, as CI and the publish workflow install. CI's `Lockfiles
agree` job fails when `bun.lock` doesn't match `package.json`
(`bun install --frozen-lockfile`) or when the two resolve the stack's
packages (`@animalabs/*`) differently (`node scripts/lockfiles-agree.mjs`,
which follows the stack's dependencies from the root, through each stack
package's own, comparing registry versions, GitHub commits and tarball
URLs; a pin of another kind on both sides, such as a link, fails as one
it can't compare, and the relock below doesn't clear it, while against a
pin of a known kind it differs; other packages may differ, and a stack
package that only a third-party package depends on, or one declared
under an alias outside `@animalabs/`, isn't reached). So
when you change a dependency, update
`package-lock.json` with npm, then make `bun.lock`
follow it as for `web/`: delete `bun.lock` and run
`bun install --lockfile-only`.

CI also runs the pack check described under Releases, on ubuntu. Its
install resolves dependencies from the registry as it stands, not from
the lockfiles, so a new upstream release can turn it red on a change that
touched nothing it installs: rerunning it on `main` tells the two apart.

See `docs/DEV-ENVIRONMENT.md` for the full dev setup, `ARCHITECTURE.md` for
how the host is built, and `docs/README.md` for the index of operations and
workflow guides.
