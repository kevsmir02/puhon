# Release Automation: CHANGELOG Generation, Version Bump, Tag Flow

**Date:** 2026-07-22
**Status:** Approved
**Roadmap item:** Release automation. CHANGELOG generation, version bump, tag flow.

## Problem

The current release process is manual and error-prone:

- **Version bump is manual and unsynchronized.** The last release (`v0.9.1`) bumped `package.json` and `tauri.conf.json` to `0.9.1` but forgot `Cargo.toml`, which is still at `0.9.0`. Three version files, edited by hand, drift.
- **Release notes are not generated.** `scripts/release-notes.sh` exists and produces structured notes from conventional commits, but `release.yml` hardcodes the release body as "See the assets to download and install. Auto-update is built in." instead of running the script.
- **The tag flow is ad hoc.** A developer manually edits version files, commits, tags, and pushes. No pre-flight checks catch a dirty tree, wrong branch, or version drift before the bump.

## Decisions

- **No CHANGELOG.md file in the repo.** Release notes live on the GitHub Release page only, generated at release time from conventional commits. No in-repo changelog history to maintain.
- **Local script, manual trigger.** A developer runs `pnpm release patch|minor|major` (or `scripts/release.sh` directly) when they decide to cut a release. No commit-message-driven automation, no CI-driven bumping. Explicit control.
- **CI generates release notes.** The local script only does version bump + tag + push. `release.yml` runs `release-notes.sh` and sets the GitHub Release body automatically. Single source of truth, runs where the build runs.
- **Custom bash script.** Uses `jq` for JSON files, `sed` for `Cargo.toml`, `cargo update` for the lockfile. Zero new dependencies. Consistent with the existing `release-notes.sh` style.

## Design

### Component 1: `scripts/release.sh`

**Usage:**
```
scripts/release.sh <patch|minor|major> [--pre <prerelease>] [--dry-run]
```

**Behavior, in order:**

1. **Pre-flight checks (fail fast):**
   - Working tree must be clean (`git diff --quiet && git diff --cached --quiet`).
   - Current branch must be `main`.
   - Local `main` must not be behind `origin/main` (`git rev-list --count HEAD..origin/main` must be 0).
   - **Drift detection:** Read the version from all three files (`package.json`, `tauri.conf.json`, `Cargo.toml`). If they disagree, print which files differ and abort. The developer must fix the drift manually before releasing. This prevents a repeat of the 0.9.1 situation.

2. **Compute new version:**
   - Read current version from `package.json` (the canonical source).
   - If `--pre` is provided:
     - If the current version already has a prerelease suffix matching `<pre>`, increment the prerelease number (e.g. `0.9.1-rc.1` -> `0.9.1-rc.2`).
     - Otherwise, strip any existing prerelease, increment the base per `patch|minor|major`, and append `-<pre>.1` (e.g. `0.9.1 --pre rc --minor` -> `0.10.0-rc.1`).
   - If no `--pre`:
     - Strip any existing prerelease suffix from the current version first, then increment per `patch|minor|major` (e.g. `0.9.1-rc.2 --minor` -> `0.10.0`; `0.9.1 --patch` -> `0.9.2`).
   - Semver math is ~15 lines of bash: split on `.`, increment the relevant component, reset lower components to 0.

3. **Bump all three files in sync:**
   - `package.json`: `jq --arg v "$NEW" '.version = $v' package.json > tmp && mv tmp package.json`
   - `src-tauri/tauri.conf.json`: same `jq` pattern.
   - `src-tauri/Cargo.toml`: `sed -i` replacing the `version = "..."` line under `[package]` (first occurrence only, to avoid touching dependency versions).
   - `src-tauri/Cargo.lock`: `cargo update -p puhon --precise "$NEW"` (updates the lockfile entry without touching dependencies).

4. **Verify sync:**
   - Re-read the version from all three files. If any disagree with `$NEW`, print the mismatch and abort. The working tree has edits but no commit; the user can `git checkout .` to clean up.

5. **Commit + tag + push:**
   - `git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock`
   - `git commit -m "chore: bump version to $NEW"`
   - `git tag "v$NEW"`
   - `git push origin main && git push origin "v$NEW"`

   If `--dry-run` is set, skip this step (and step 3's file writes) entirely. Print the computed version and the files that would change, then exit.

6. The tag push triggers `release.yml`, which builds and publishes.

**Error handling:**
- Any pre-flight failure prints a clear message and exits non-zero. No files are touched.
- Any bump/verify failure prints the problem and exits. The working tree has uncommitted edits; the user runs `git checkout .` to clean up. No commit or tag is created.
- If the push fails (e.g. someone pushed between the pre-flight check and the push), the commit and tag exist locally. The user resolves the conflict and re-pushes manually.

**Prerelease tag format:** `v0.10.0-rc.1` (switching from the old `v0.8.0-rc1` convention to the dotted format for semver compliance and correct GitHub Release sort order).

### Component 2: `release.yml` changes

Add a "Generate release notes" step before the `tauri-action` step. This step runs `scripts/release-notes.sh` with the tag name and captures the output as a step output for `releaseBody`.

```yaml
- name: Generate release notes
  id: notes
  run: |
    body="$(scripts/release-notes.sh "${{ github.ref_name }}")"
    echo "body<<EOF" >> "$GITHUB_OUTPUT"
    echo "$body" >> "$GITHUB_OUTPUT"
    echo "EOF" >> "$GITHUB_OUTPUT"
```

Change the `tauri-action` step's `releaseBody` from the hardcoded string to `${{ steps.notes.outputs.body }}`.

The `release-notes.sh` script already reads conventional commits between the previous tag and the given tag and produces categorized markdown. No changes to the script are needed.

For `workflow_dispatch` (manual trigger without a tag), the notes step should handle the case where `github.ref_name` is a branch name, not a tag. In that case, `release-notes.sh` will fail to find a matching tag; the step should fall back to a placeholder body. This is a minor edge case since the primary trigger is tag push.

### Component 3: `package.json` script entry

Add to the `scripts` section:
```json
"release": "scripts/release.sh"
```

So the developer runs `pnpm release patch`, `pnpm release minor`, `pnpm release major`, or `pnpm release patch --pre rc`.

## Out of Scope

- **No CHANGELOG.md file in the repo.** Release notes are GitHub Release page only.
- **No auto-detection of bump type from commits.** The developer specifies `patch|minor|major` explicitly.
- **No macOS/Windows build legs.** Separate roadmap item ("macOS / Windows release pipeline").
- **No `semantic-release`, `standard-version`, or `release-please`.** Overkill for this project's conventional-commit-based flow with a single maintainer.
- **No GitHub Release creation from the local script.** The local script only bumps + tags + pushes. CI creates the release via `tauri-action`.

## Files Changed

| File | Change |
|------|--------|
| `scripts/release.sh` | New: version bump + tag + push script |
| `.github/workflows/release.yml` | Add release notes generation step, wire into `releaseBody` |
| `package.json` | Add `"release": "scripts/release.sh"` to scripts |

## Testing

- **`scripts/release.sh` dry run:** The script should support a `--dry-run` flag that performs all pre-flight checks, computes and prints the new version, and shows which files would change, but does not edit, commit, tag, or push.
- **Drift detection:** Manually desync one version file, run the script, confirm it aborts with a clear message.
- **Semver math:** Test all three bump types from a clean version, from a prerelease, and from a prerelease with `--pre` increment.
- **CI notes:** Push a tag, confirm the GitHub Release body contains the categorized commit list instead of the placeholder string.
