#!/bin/bash
# guard.sh: preflight for any manual deploy script. Source it or run it first.
#
#   bash ~/site-toolkit/scripts/guard.sh --config site.config.json [--force]
#
# Refuses to continue when the repo is dirty, behind origin/main, or holds
# unpushed commits, then runs the drift check against the live server. Every
# one of those states has caused work to be overwritten or stranded before:
# a stale checkout deploying over another machine's work, or a feature that
# lived only on a server because it was deployed but never committed.
#
# --force skips everything. Exit 0 means safe to deploy.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG=""; FORCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) shift ;;
  esac
done
[ -z "$FORCE" ] || { echo "guard: --force given, skipping checks"; exit 0; }

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "guard: not in a git repo" >&2; exit 1; }

if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  echo "ABORTED: uncommitted changes. Commit first, so the other machines get this work." >&2
  echo "         Override with --force if you really mean to deploy untracked work." >&2
  exit 1
fi
git -C "$REPO" fetch --quiet origin 2>/dev/null || true
BEHIND=$(git -C "$REPO" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
AHEAD=$(git -C "$REPO" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
if [ "$BEHIND" != "0" ]; then
  echo "ABORTED: $BEHIND commit(s) behind origin/main. Another machine has work you do not." >&2
  echo "         Run: git pull --rebase" >&2
  exit 1
fi
if [ "$AHEAD" != "0" ]; then
  echo "ABORTED: $AHEAD unpushed commit(s). Run: git push" >&2
  exit 1
fi

if [ -n "$CONFIG" ]; then
  echo "Checking what is live..."
  if ! node "$HERE/live-check.js" --config "$CONFIG" --deep; then
    echo "" >&2
    echo "ABORTED: live content is not in this repo. Reconcile first, or --force." >&2
    exit 1
  fi
fi
exit 0
