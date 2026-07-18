# Releasing Terax

How to cut a release and what happens when you do. Written for both humans and AI agents.

## Version locations

The version string must be identical in both files - bump them together:

- `package.json` -> `"version"`
- `src-tauri/tauri.conf.json` -> `"version"`

Cargo.toml does not carry a version (Tauri reads it from `tauri.conf.json`).

## Steps to release

```
# 1. Bump version in both files (package.json + tauri.conf.json)
# 2. Commit
git commit -am "chore: bump version to X.Y.Z"

# 3. Tag the commit
git tag vX.Y.Z

# 4. Push the branch
git push origin main

# 5. Push ONLY the new tag
git push origin vX.Y.Z
```

That last line is the whole game. The release workflow fires on the tag push.

## Critical gotcha: never use `git push --tags`

`git push --tags` pushes **every** unpushed local tag in one shot. If you have stale local tags (old betas, rc tags, forgotten tags from other branches), GitHub receives a flood of tag-push events at once and silently drops the release trigger for the tag you actually care about. The CI workflow on `main` still runs, but the **Release** workflow never fires and no GitHub release is created.

Always push the specific tag:

```
git push origin vX.Y.Z        # correct
git push --tags               # wrong - drops the trigger if other tags exist
git push origin main --tags   # wrong - same problem
```

If you already pushed too many tags, the fix is to force-push the release tag alone:

```
git push origin vX.Y.Z --force
```

This re-fires the Release workflow for that tag.

## Workflows

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| CI | `.github/workflows/ci.yml` | push to `main`, PRs to `main` | lint, type-check, test, build, size budget, Rust clippy/test/coverage |
| Release | `.github/workflows/release.yml` | tag push `v*`, manual dispatch | build RPM, create GitHub release with changelog, upload `.rpm` + `.sig` |

CI and Release are independent - Release does not wait for CI and does not run the size budget. But you should still land the version-bump commit on `main` first so CI validates the exact code being shipped.

### Release workflow steps

1. Checkout, install deps (pnpm + Rust).
2. `pnpm tauri build --bundles rpm` (signs the binary with `TAURI_SIGNING_PRIVATE_KEY`).
3. `scripts/release-notes.sh "$GITHUB_REF_NAME"` generates structured markdown changelog.
4. `gh release create` with `--notes-file`, uploads the `.rpm` and `.rpm.sig`.

## Changelog format

Generated automatically by `scripts/release-notes.sh` from conventional-commit subjects between the previous tag and the new one. The output looks like:

```markdown
## What's new

- resolve relative image paths in markdown preview
- add Mermaid diagram support to Markdown preview

## Changes

- address review feedback for parallel tests

**Full Changelog**: https://github.com/kevsmir02/terax-ai/compare/v0.8.8...v0.8.9
```

### Categorization

Commit prefix (from the subject line) determines placement:

| Prefix | Section |
| -------- | --------- |
| `feat:` | What's new |
| `fix:` | Changes |
| `perf:`, `refactor:`, `revert:` | Changes |
| `docs:`, `style:`, `chore:`, `ci:`, `build:`, `test:` | skipped (noise) |
| (no recognizable prefix) | Changes |

### Keeping the changelog clean

The changelog is only as good as the commit subjects. Guidelines:

- Use conventional prefixes (`feat:`, `fix:`, `refactor:`, etc.).
- Write the subject as a user-facing description, not an implementation step. `feat: add terminal scrollback persistence` is one good commit (or a squashed set); splitting it into `add Rust commands`, `add invoke wrappers`, `wire save triggers` floods "What's new" with internals.
- Scope is fine and preserved: `feat(editor): add image zoom` shows as "add image zoom".
- If a feature spans many sub-commits, squash or write a merge commit with a clean subject before tagging.

## Commit conventions (summary)

```
feat:     new user-facing feature
fix:      bug fix
perf:     performance improvement
refactor: code change that neither fixes a bug nor adds a feature
docs:     documentation only
style:    formatting, whitespace, semicolons (no logic change)
test:     adding or correcting tests
chore:    build process, tooling, dependencies, version bumps
ci:       CI configuration changes
build:    build system or external dependencies
revert:   revert a previous commit
```

No em-dash. No emojis. Keep the subject imperative ("add", not "added" or "adds").
