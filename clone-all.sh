#!/usr/bin/env bash
#
# clone-all.sh — clone every repo listed in projects.json, one at a time.
#
# Meant for setting up a new box. Reads the same projects.json the CLI and the
# dashboard use, so there is one list to keep current. If projects.json isn't
# sitting next to this script it is fetched from GitHub, which means this file
# also works standalone:
#
#   curl -fsSL https://raw.githubusercontent.com/deftio/diorepo/main/clone-all.sh | bash -s -- ~/src
#
# Usage:
#   ./clone-all.sh [target-dir] [--ssh] [--dry-run]
#
#   target-dir   where to clone into (default: current directory)
#   --ssh        use git@github.com: URLs instead of https://
#   --dry-run    list what would be cloned, clone nothing
#
# Already-cloned repos are skipped, so re-running is safe.

set -uo pipefail

RAW_URL="https://raw.githubusercontent.com/deftio/diorepo/main/projects.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo .)"

TARGET_DIR="."
USE_SSH=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --ssh)     USE_SSH=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "Unknown option: $arg" >&2
      exit 2 ;;
    *)         TARGET_DIR="$arg" ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "git is not installed." >&2; exit 1; }

# Locate the project list: prefer a local copy, fall back to the published one.
read_projects() {
  if [ -f "$SCRIPT_DIR/projects.json" ]; then
    cat "$SCRIPT_DIR/projects.json"
  elif [ -f "./projects.json" ]; then
    cat "./projects.json"
  elif command -v curl >/dev/null 2>&1; then
    echo "Fetching project list from GitHub..." >&2
    curl -fsSL "$RAW_URL"
  else
    echo "No projects.json found and curl is unavailable." >&2
    return 1
  fi
}

# Pull the "owner/repo" values out of the JSON with grep/sed rather than jq or
# node, so this runs on a box where nothing is installed yet.
REPOS="$(read_projects | grep -o '"github"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"

if [ -z "$REPOS" ]; then
  echo "Could not read any repos from projects.json." >&2
  exit 1
fi

TOTAL=$(printf '%s\n' "$REPOS" | wc -l | tr -d ' ')
echo "Found $TOTAL repos."

if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$TARGET_DIR" || exit 1
  cd "$TARGET_DIR" || exit 1
fi
echo "Target: $(pwd)"
echo

cloned=0; skipped=0; failed=0
failures=""

for repo in $REPOS; do
  name="${repo##*/}"

  if [ -d "$name/.git" ]; then
    echo "skip   $name (already cloned)"
    skipped=$((skipped + 1))
    continue
  fi
  if [ -e "$name" ]; then
    echo "skip   $name (path exists, not a git repo)"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$USE_SSH" -eq 1 ]; then
    url="git@github.com:${repo}.git"
  else
    url="https://github.com/${repo}.git"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would clone $url"
    cloned=$((cloned + 1))
    continue
  fi

  echo "clone  $name"
  if git clone --quiet "$url"; then
    cloned=$((cloned + 1))
  else
    echo "FAILED $repo" >&2
    failed=$((failed + 1))
    failures="${failures}  $repo"$'\n'
  fi
done

echo
echo "cloned: $cloned   skipped: $skipped   failed: $failed"
if [ "$failed" -gt 0 ]; then
  printf 'failed repos:\n%s' "$failures" >&2
  exit 1
fi
