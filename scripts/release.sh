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

# macOS ships BSD sed (no -i without backup suffix, no 0,/RE/ range);
# prefer gsed from Homebrew if available.
SED=sed
if command -v gsed >/dev/null 2>&1; then
  SED=gsed
elif ! sed --version 2>/dev/null | head -1 | grep -q GNU; then
  # We are on BSD sed -- fail early with a helpful message.
  echo "error: GNU sed is required. Install it with: brew install gnu-sed" >&2
  exit 1
fi

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
CARGO_VER="$($SED -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -1)"

if [ "$PKG_VER" != "$TAURI_VER" ] || [ "$PKG_VER" != "$CARGO_VER" ]; then
  fail "version drift detected:
  package.json:      $PKG_VER
  tauri.conf.json:   $TAURI_VER
  Cargo.toml:        $CARGO_VER
Fix the drift manually before releasing."
fi

CURRENT="$PKG_VER"
echo "current version: $CURRENT"

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
$SED -i "0,/^version = \".*\"$/s//version = \"$NEW\"/" src-tauri/Cargo.toml

# Update Cargo.lock
(cd src-tauri && cargo update -p puhon --precise "$NEW" --quiet)

# --- verify sync ---

VERIFY_PKG="$(jq -r '.version' package.json)"
VERIFY_TAURI="$(jq -r '.version' src-tauri/tauri.conf.json)"
VERIFY_CARGO="$($SED -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -1)"

if [ "$VERIFY_PKG" != "$NEW" ] || [ "$VERIFY_TAURI" != "$NEW" ] || [ "$VERIFY_CARGO" != "$NEW" ]; then
  fail "post-bump verification failed:
  package.json:      $VERIFY_PKG (expected $NEW)
  tauri.conf.json:   $VERIFY_TAURI (expected $NEW)
  Cargo.toml:        $VERIFY_CARGO (expected $NEW)
Run 'git checkout .' to discard the partial changes."
fi

# --- commit, tag, push ---

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump version to $NEW"
git tag "v$NEW"
git push origin main
git push origin "v$NEW"

echo ""
echo "released v$NEW. CI will build and publish the GitHub Release."
