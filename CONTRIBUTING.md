# Contributing to connectome-host

connectome-host is part of the Connectome ecosystem
([agent-framework](https://github.com/anima-research/agent-framework),
[membrane](https://github.com/antra-tess/membrane),
[context-manager](https://github.com/anima-research/context-manager),
[chronicle](https://github.com/anima-research/chronicle)). These conventions
describe how work actually lands here — they codify existing practice rather
than aspiration. When in doubt, recent merged PRs are the best reference.

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
- **Changelog entry** under `## Unreleased` for anything behavior-affecting
  (see below).

Conventional-commit-style titles (`feat(recipe): …`, `fix(subagent): …`) are
the house default; plain descriptive titles are accepted.

## Review process — what to expect

- Review arrives as **ordinary PR comments**, not GitHub review approvals —
  the comment thread is the gate. Reviews are frequently AI-generated and
  explicitly labeled as such, with a severity verdict and itemized findings.
- The reviewer will typically **run your branch** (typecheck, test suite,
  loading a recipe) and paste transcripts. Claims are checked, not trusted.
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

`CHANGELOG.md` keeps a standing `## Unreleased` section with
`### Breaking` / `### Added` / `### Changed` / `### Fixed` subsections
(loosely [Keep a Changelog](https://keepachangelog.com/)).

- **The entry lands with the change** — same PR, ideally same commit. CI
  enforces this softly: a PR touching `src/` without touching `CHANGELOG.md`
  fails the `changelog` check unless the `no-changelog` label is applied.
- **What needs an entry:** anything an operator, recipe author, or module
  developer would notice — behavior, config/recipe schema, CLI, tool
  surfaces, defaults. Internal refactors, test-only, and docs-only changes
  don't.
- **Breaking entries are audience-scoped.** Name the audience in the heading
  (`### Breaking (recipe authors only)`) and cover: **who needs to act**,
  **migration**, and **unchanged** (what readers might fear broke but
  didn't). The fleet recipe-path entry in `CHANGELOG.md` is the canonical
  example of the format.
- **Releases:** the release commit retitles `Unreleased` to
  `## X.Y.Z — YYYY-MM-DD` and bumps `package.json` — then the `vX.Y.Z` tag is
  pushed. The publish workflow refuses to release a version with no matching
  changelog section. Version bumps are a maintainer release-time action, not
  part of feature PRs.

## Building and testing

```bash
bun install
bun test            # test suite
bunx tsc --noEmit   # typecheck
bun src/index.ts    # run (generic assistant)
```

See `docs/DEV-ENVIRONMENT.md` for the full dev setup and `docs/` generally
for architecture and operations guides.
