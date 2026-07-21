# Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate version bumping (all three version files in sync), tag creation, push, and release note generation so a single `pnpm release patch` command cuts a release.

**Architecture:** A local bash script (`scripts/release.sh`) handles pre-flight checks, semver computation, synchronized file bumping, commit, tag, and push. The existing `release.yml` CI workflow is extended to run `scripts/release-notes.sh` and feed the output into the GitHub Release body via tauri-action's `releaseBody` input. A `package.json` script entry provides the `pnpm release` entry point.

**Tech Stack:** Bash, jq, sed, cargo, GitHub Actions YAML

## Global Constraints

- No emojis or em-dashes in code, comments, or commit messages.
- Commit messages follow conventional commits: `chore: bump version to X`, `feat: ...`, `fix: ...`.
- `jq` is available in the CI environment and assumed available locally (standard on Linux/macOS).
- `cargo` is required locally (the project is a Tauri app).
- Three version files must stay in sync: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`. The lockfile `src-tauri/Cargo.lock` follows from `Cargo.toml`.
- Tags follow `v<version>` format (e.g. `v0.9.2`, `v0.10.0-rc.1`).
- `package.json` is the canonical version source.
- Scripts directory already contains `release-notes.sh` (bash, conventional-commit-based notes generator). This plan adds `release.sh` alongside it.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `scripts/release.sh` | New. Version bump + tag + push script. Pre-flight checks, semver math, synchronized file editing, git commit/tag/push, `--dry-run` mode. |
| `.github/workflows/release.yml` | Modify. Add release notes generation step, wire into `releaseBody`. |
| `package.json` | Modify. Add `"release": "scripts/release.sh"` to scripts section. |

---

### Task 1: `scripts/release.sh` — version bump + tag + push script

**Files:**
- Create: `scripts/release.sh`

**Interfaces:**
- Consumes: `package.json` (version field), `src-tauri/tauri.conf.json` (version field), `src-tauri/Cargo.toml` (version field), `src-tauri/Cargo.lock` (puhon version entry), `scripts/release-notes.sh` (not called by this script, but CI calls it)
- Produces: A git commit `chore: bump version to <new>` and tag `v<new>` pushed to origin

This is one cohesive script — partial versions are not useful. Build it in steps, test as a whole.

- [ ] **Step 1: Create the script skeleton with pre-flight checks**

Create `scripts/release.sh`:

```bash
#!/usr/bin/env bash
# Bump version across package.json, tauri.conf.json, Cargo.toml (and
# Cargo.lock), commit, tag, and push. Triggers the release CI workflow.
#
# Usage: scripts/release.sh <patch|minor|major> [--pre <prerelease>] [--dry-run]
#
# Pre-flight: fails on dirty tree, wrong branch, unpushed commits, or
# version drift between the three version files.
#
# --dry-run: compute and print the new version and files that would change,
# but do not edit, commit, tag, or push.

set -euo pipefail

DRY_RUN=false
PRE=""
BUMP=""

usage() {
  echo "usage: scripts/release.sh <patch|minor|major> [--pre <prerelease>] [--dry-run]" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    patch|minor|major) BUMP="$1" ;;
    --pre) shift; [ $# -gt 0 ] || usage; PRE="$1" ;;
    --dry-run) DRY_RUN=true ;;
    *) usage ;;
  esac
  shift
done

[ -n "$BUMP" ] || usage

# --- pre-flight checks ---

fail() { echo "error: $*" >&2; exit 1; }

# Clean working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "working tree is dirty. commit or stash your changes first."
fi

# On main branch
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "not on main (currently on '$BRANCH')."

# Up to date with origin/main
git fetch origin main --quiet
BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
[ "$BEHIND" -eq 0 ] || fail "local main is $BEHIND commit(s) behind origin/main. pull first."

# --- drift detection ---

PKG_VER="$(jq -r '.version' package.json)"
TAURI_VER="$(jq -r '.version' src-tauri/tauri.conf.json)"
CARGO_VER="$(sed -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -1)"

if [ "$PKG_VER" != "$TAURI_VER" ] || [ "$PKG_VER" != "$CARGO_VER" ]; then
  fail "version drift detected:
  package.json:      $PKG_VER
  tauri.conf.json:   $TAURI_VER
  Cargo.toml:        $CARGO_VER
Fix the drift manually before releasing."
fi

CURRENT="$PKG_VER"
echo "current version: $CURRENT"
```

- [ ] **Step 2: Add semver computation**

Append to `scripts/release.sh` (before the final `echo "current version: $CURRENT"` line, or restructure so the script flows linearly). The semver math:

```bash
# --- compute new version ---

# Strip prerelease suffix: 0.9.1-rc.2 -> 0.9.1
BASE_VER="${CURRENT%%-*}"
PRE_SUFFIX="${CURRENT#*-}"
[ "$PRE_SUFFIX" = "$CURRENT" ] && PRE_SUFFIX=""  # no prerelease present

# Parse base into major.minor.patch
IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE_VER"

increment_base() {
  case "$BUMP" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
  esac
}

if [ -n "$PRE" ]; then
  # Check if the current prerelease type matches the requested one.
  # e.g. PRE_SUFFIX="rc.1" -> prefix "rc"; PRE_SUFFIX="rc" -> prefix "rc"
  PRE_TYPE="${PRE_SUFFIX%%.*}"
  if [ -n "$PRE_SUFFIX" ] && [ "$PRE_TYPE" = "$PRE" ]; then
    # Same prerelease type: increment the number
    PRE_NUM="${PRE_SUFFIX#*.}"
    if [ "$PRE_NUM" = "$PRE_SUFFIX" ]; then
      # No dot in suffix (e.g. "rc"): treat as first, next is .2
      NEW_PRE="$PRE.2"
    else
      NEW_PRE="$PRE.$((PRE_NUM + 1))"
    fi
    NEW="$BASE_VER-$NEW_PRE"
  else
    # Different or no prerelease: bump base, start at .1
    increment_base
    NEW="$MAJOR.$MINOR.$PATCH-$PRE.1"
  fi
else
  # No prerelease requested: strip any existing, bump base
  increment_base
  NEW="$MAJOR.$MINOR.$PATCH"
fi

echo "new version:     $NEW"
```

- [ ] **Step 3: Add file bumping and verify sync**

Append the file-editing section. In `--dry-run` mode, print what would change and exit:

```bash
# --- bump files ---

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "dry run: no files changed."
  echo "would update: package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock"
  echo "would commit: chore: bump version to $NEW"
  echo "would tag:     v$NEW"
  exit 0
fi

jq --arg v "$NEW" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json
jq --arg v "$NEW" '.version = $v' src-tauri/tauri.conf.json > tauri.conf.json.tmp && mv tauri.conf.json.tmp src-tauri/tauri.conf.json
sed -i "0,/^version = \".*\"$/s//version = \"$NEW\"/" src-tauri/Cargo.toml

# Update Cargo.lock
(cd src-tauri && cargo update -p puhon --precise "$NEW" --quiet)

# --- verify sync ---

VERIFY_PKG="$(jq -r '.version' package.json)"
VERIFY_TAURI="$(jq -r '.version' src-tauri/tauri.conf.json)"
VERIFY_CARGO="$(sed -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -1)"

if [ "$VERIFY_PKG" != "$NEW" ] || [ "$VERIFY_TAURI" != "$NEW" ] || [ "$VERIFY_CARGO" != "$NEW" ]; then
  fail "post-bump verification failed:
  package.json:      $VERIFY_PKG (expected $NEW)
  tauri.conf.json:   $VERIFY_TAURI (expected $NEW)
  Cargo.toml:        $VERIFY_CARGO (expected $NEW)
Run 'git checkout .' to discard the partial changes."
fi
```

- [ ] **Step 4: Add commit, tag, push**

Append the final section:

```bash
# --- commit, tag, push ---

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump version to $NEW"
git tag "v$NEW"
git push origin main
git push origin "v$NEW"

echo ""
echo "released v$NEW. CI will build and publish the GitHub Release."
```

- [ ] **Step 5: Make the script executable and verify syntax**

```bash
chmod +x scripts/release.sh
bash -n scripts/release.sh
```

Run `bash -n` to confirm no syntax errors. Expected: no output, exit 0.

- [ ] **Step 6: Test dry-run mode**

Run:
```bash
scripts/release.sh patch --dry-run
```

Expected output:
```
current version: 0.9.1
new version:     0.9.2

dry run: no files changed.
would update: package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock
would commit: chore: bump version to 0.9.2
would tag:     v0.9.2
```

Also test minor and major dry runs to verify semver math:
```bash
scripts/release.sh minor --dry-run
# expected: new version 0.10.0

scripts/release.sh major --dry-run
# expected: new version 1.0.0
```

Test prerelease dry runs:
```bash
scripts/release.sh patch --pre rc --dry-run
# expected: new version 0.9.2-rc.1
```

- [ ] **Step 7: Test drift detection (manual)**

Temporarily desync a version file:
```bash
sed -i 's/"version": "0.9.1"/"version": "0.9.2"/' package.json
scripts/release.sh patch --dry-run
# expected: error about version drift
git checkout package.json
```

- [ ] **Step 8: Commit**

```bash
git add scripts/release.sh
git commit -m "feat: add release.sh version bump and tag script"
```

---

### Task 2: Wire release notes into `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml` (lines ~55-70, the tauri-action step)

**Interfaces:**
- Consumes: `scripts/release-notes.sh` (already exists, takes a tag arg, outputs markdown to stdout)
- Produces: GitHub Release body populated with categorized conventional commits instead of the placeholder string

- [ ] **Step 1: Add the release notes generation step**

In `.github/workflows/release.yml`, insert a new step before the `tauri` step (before line 58 `- id: tauri`). The new step runs `release-notes.sh` and captures output:

```yaml
      - name: Generate release notes
        id: notes
        run: |
          body="$(scripts/release-notes.sh "${{ github.ref_name }}")"
          echo "body<<EOF" >> "$GITHUB_OUTPUT"
          echo "$body" >> "$GITHUB_OUTPUT"
          echo "EOF" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 2: Wire the notes into releaseBody**

Change the `tauri-action` step's `releaseBody` line from:

```yaml
          releaseBody: "See the assets to download and install. Auto-update is built in."
```

to:

```yaml
          releaseBody: ${{ steps.notes.outputs.body }}
```

- [ ] **Step 3: Handle workflow_dispatch fallback**

When triggered via `workflow_dispatch` (not a tag push), `github.ref_name` is a branch name, not a tag. `release-notes.sh` will fail because `git describe` can't resolve a branch as a tag. Add a guard so the notes step falls back gracefully.

Update the notes step to:

```yaml
      - name: Generate release notes
        id: notes
        run: |
          TAG="${{ github.ref_name }}"
          if git rev-parse "refs/tags/$TAG" >/dev/null 2>&1; then
            body="$(scripts/release-notes.sh "$TAG")"
          else
            body="Release notes generated on tag push. Triggered manually from branch $TAG."
          fi
          echo "body<<EOF" >> "$GITHUB_OUTPUT"
          echo "$body" >> "$GITHUB_OUTPUT"
          echo "EOF" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 4: Verify YAML syntax**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

Expected: no output, exit 0 (valid YAML). Alternatively use `yamllint` if available.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat: wire release notes into CI release workflow"
```

---

### Task 3: Add `release` script entry to `package.json`

**Files:**
- Modify: `package.json` (scripts section, after line 27)

**Interfaces:**
- Consumes: `scripts/release.sh` (from Task 1)
- Produces: `pnpm release <patch|minor|major>` entry point

- [ ] **Step 1: Add the script entry**

In `package.json`, add to the `"scripts"` object (after the last entry, `"knip": "knip"`):

```json
    "release": "scripts/release.sh"
```

The line should have a trailing comma added to the `"knip"` line above it:
```json
    "knip": "knip",
    "release": "scripts/release.sh"
```

- [ ] **Step 2: Verify it runs**

```bash
pnpm release --dry-run
```

This should fail with the usage message (no bump type specified), confirming the script is wired up:

```
usage: scripts/release.sh <patch|minor|major> [--pre <prerelease>] [--dry-run]
```

Then test the actual dry run through pnpm:
```bash
pnpm release patch -- --dry-run
```

Expected: same output as `scripts/release.sh patch --dry-run`.

Note: `pnpm` passes `--` args through. If `pnpm release patch --dry-run` works without `--`, use that form instead. Test both.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add pnpm release script entry"
```

---

### Task 4: Manual integration verification

No code changes. Verify the full flow works end-to-end without actually cutting a release.

- [ ] **Step 1: Verify dry-run for all bump types**

```bash
pnpm release patch -- --dry-run
pnpm release minor -- --dry-run
pnpm release major -- --dry-run
pnpm release patch -- --pre rc --dry-run
```

Confirm all produce correct semver output and exit 0 without modifying any files.

- [ ] **Step 2: Verify drift detection**

```bash
sed -i 's/"version": "0.9.1"/"version": "0.9.0"/' package.json
pnpm release patch -- --dry-run
# expected: error about version drift
git checkout package.json
```

- [ ] **Step 3: Verify release.yml changes are valid**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

- [ ] **Step 4: Verify no files were accidentally modified**

```bash
git status
git diff
```

Expected: clean working tree (all test changes reverted via `git checkout`).

- [ ] **Step 5: Mark complete**

No commit needed. Task is verification only.
