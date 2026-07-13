# connectome-host

Bun-based agent host (TUI + web UI) with recipe-based configuration, built on
`@animalabs/agent-framework` + `membrane` + `context-manager` + `chronicle`.
Architecture and operations guides live in `docs/`; contribution conventions
in `CONTRIBUTING.md`.

## Definition of done

- **Changelog:** any behavior-affecting change — behavior, recipe/config
  schema, CLI, tool surfaces, defaults — adds an entry to `CHANGELOG.md`
  under `## Unreleased` in the same commit. Categories:
  `### Breaking` / `### Added` / `### Changed` / `### Fixed`. Breaking
  entries are audience-scoped (name the audience in the heading) and state
  who needs to act, the migration, and what's unchanged. Test-only,
  docs-only, and purely internal refactors are exempt.
- **Tests:** behavior changes come with tests. Verify with `bun test` and
  report counts against the `main` baseline, plus `bunx tsc --noEmit`.

## Commands

- `bun test` — test suite
- `bunx tsc --noEmit` — typecheck
- `bun src/index.ts [recipe.json]` — run

## Conventions (see CONTRIBUTING.md for detail)

- PRs merge as true merge commits — never squash or rebase-merge.
- Branch names: `feat/`, `fix/`, `docs/`, `chore/` + kebab-case.
- `package.json` version bumps happen only in maintainer release commits
  (which also retitle the changelog's `Unreleased` section), never in
  feature work.
- Declare stacked or cross-repo companion PRs with merge-order guidance.
