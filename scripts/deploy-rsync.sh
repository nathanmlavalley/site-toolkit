#!/bin/bash
# deploy-rsync.sh: mirror a site's source directory to its host with rsync
# over SSH, driven entirely by site.config.json.
#
#   deploy-rsync.sh --config path/to/site.config.json [--dry-run]
#
# The config's "remote" is user@host:path/. Optional "ssh": { "port", "key" }
# gives the port and the key file for local use; in CI the reusable workflow
# writes the key secret to a file and exports SSH_KEY_FILE. The exclude list
# is the same one the drift checker reads, so the two cannot disagree.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"

CONFIG=""; DRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --dry-run) DRY="--dry-run"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$CONFIG" ] || { echo "usage: deploy-rsync.sh --config <site.config.json> [--dry-run]" >&2; exit 2; }

eval "$(node "$HERE/config.js" --config "$CONFIG" --shell)"
[ "$SITE_TRANSPORT" = "rsync" ] || { echo "$SITE_LABEL: transport is $SITE_TRANSPORT, not rsync" >&2; exit 2; }
[ -n "$SITE_REMOTE" ] && [ "$SITE_REMOTE" != "." ] || { echo "$SITE_LABEL: remote must be user@host:path/" >&2; exit 2; }

REPO="$(git rev-parse --show-toplevel)"
SRC="$REPO/$SITE_SOURCE/"
[ -d "$SRC" ] || { echo "$SITE_LABEL: source dir $SITE_SOURCE not found" >&2; exit 2; }

SSH="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
[ -n "${SSH_PORT:-}" ] && SSH="$SSH -p $SSH_PORT"
KEY="${SSH_KEY_FILE:-${SSH_KEY_PATH:-}}"
[ -n "$KEY" ] && SSH="$SSH -i $KEY"

EX=()
while IFS= read -r g; do
  # config.js emits lftp-style globs (dir/*); rsync wants the bare path.
  [ -n "$g" ] && EX+=(--exclude "${g%/\*}")
done <<< "$SITE_EXCLUDE_GLOBS"

# macOS ships openrsync; prefer a real rsync when one is installed.
RSYNC="${RSYNC_BIN:-}"
[ -n "$RSYNC" ] || for p in /opt/homebrew/bin/rsync /usr/local/bin/rsync; do [ -x "$p" ] && { RSYNC="$p"; break; }; done
RSYNC="${RSYNC:-rsync}"

OPTS=(-az --itemize-changes)
[ -n "$SITE_DELETES" ] && OPTS+=(--delete)
[ -n "$DRY" ] && OPTS+=(--dry-run)

echo "Deploying $SITE_LABEL"
echo "  from $SITE_SOURCE  to ${SITE_REMOTE%%:*}:<path>"
[ -n "$SITE_DELETES" ] && echo "  rsync uses --delete; server-owned and secret paths are excluded"
[ -n "$DRY" ] && echo "  DRY RUN: nothing will be uploaded"

"$RSYNC" "${OPTS[@]}" -e "$SSH" "${EX[@]}" "$SRC" "$SITE_REMOTE"
echo "Deploy complete: $SITE_LABEL"
