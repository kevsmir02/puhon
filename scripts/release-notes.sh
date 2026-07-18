#!/usr/bin/env bash
# Generate structured release notes from conventional commits between the
# previous tag and the given tag.
#
# Usage: scripts/release-notes.sh <tag>
#
# Output (markdown to stdout):
#   ## What's new
#   - <feat commits, prefix stripped>
#
#   ## Changes
#   - <fix/perf/refactor commits>
#
#   **Full Changelog**: https://github.com/<repo>/compare/<prev>...<tag>
#
# Categorization by conventional-commit prefix:
#   feat        -> What's new
#   fix perf refactor revert -> Changes
#   docs style chore ci build test -> skipped (noise)
#   (no prefix) -> Changes

set -euo pipefail

TAG="${1:?usage: scripts/release-notes.sh <tag>}"
REPO="kevsmir02/terax-ai"

# Nearest tag reachable from the parent of $TAG (i.e. the previous release).
PREV_TAG="$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)"

if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..${TAG}"
else
  RANGE="${TAG}"
fi

feats=()
changes=()

while IFS= read -r subj; do
  [ -z "$subj" ] && continue
  # Strip conventional prefix: "feat(scope): msg" / "feat: msg" -> "msg"
  stripped="$(printf '%s' "$subj" | sed -E 's/^[a-z]+(\([^)]+\))?: //')"
  case "$subj" in
    feat:*|feat\(*\):*)
      feats+=("$stripped") ;;
    fix:*|fix\(*\):*|perf:*|perf\(*\):*|refactor:*|refactor\(*\):*|revert:*|revert\(*\):*)
      changes+=("$stripped") ;;
    docs:*|docs\(*\):*|style:*|chore:*|chore\(*\):*|ci:*|build:*|test:*|test\(*\):*)
      ;; # noise - skip
    *)
      changes+=("$subj") ;;
  esac
done < <(git log "$RANGE" --pretty=format:"%s" --no-merges)

emit() {
  local title="$1"; shift
  [ "$#" -eq 0 ] && return
  printf '## %s\n\n' "$title"
  local line
  for line in "$@"; do
    printf -- '- %s\n' "$line"
  done
  printf '\n'
}

{
  emit "What's new" "${feats[@]}"
  emit "Changes" "${changes[@]}"

  if [ -n "$PREV_TAG" ]; then
    printf '**Full Changelog**: https://github.com/%s/compare/%s...%s\n' \
      "$REPO" "$PREV_TAG" "$TAG"
  fi
}
