#!/bin/bash
# deploy-ftp.sh: mirror a site's source directory to its host with lftp,
# driven entirely by site.config.json.
#
#   deploy-ftp.sh --config path/to/site.config.json [--dry-run]
#
# The exclude list comes from the same config the drift checker reads, so the
# two can never disagree about which paths are server-owned or secret. Nothing
# in this script names a host, a path or an account: that is all in the
# private caller repo's config and secrets.
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
[ -n "$CONFIG" ] || { echo "usage: deploy-ftp.sh --config <site.config.json> [--dry-run]" >&2; exit 2; }

eval "$(node "$HERE/config.js" --config "$CONFIG" --shell)"

[ "$SITE_TRANSPORT" = "ftp" ] || { echo "$SITE_LABEL: transport is $SITE_TRANSPORT, not ftp" >&2; exit 2; }
: "${FTP_HOST:?$SITE_LABEL: no FTP host resolved. Check credentials.host and where the value should come from.}"
: "${FTP_USER:?$SITE_LABEL: no FTP user resolved}"
: "${FTP_PASSWORD:?$SITE_LABEL: no FTP password resolved}"

REPO="$(git rev-parse --show-toplevel)"
SRC="$REPO/$SITE_SOURCE"
[ -d "$SRC" ] || { echo "$SITE_LABEL: source dir $SITE_SOURCE not found" >&2; exit 2; }

LFTP="${LFTP_BIN:-}"
[ -n "$LFTP" ] || for p in /opt/homebrew/bin/lftp /usr/local/bin/lftp /usr/bin/lftp; do
  [ -x "$p" ] && { LFTP="$p"; break; }
done
LFTP="${LFTP:-lftp}"

# lftp -e treats a newline as the end of a command, so the mirror options are
# assembled on one line. Globs are quoted individually.
OPTS="--reverse --only-newer --verbose"
[ -n "$SITE_DELETES" ] && OPTS="$OPTS --delete"
[ -n "$DRY" ] && OPTS="$OPTS --dry-run"
while IFS= read -r g; do
  [ -n "$g" ] && OPTS="$OPTS --exclude-glob '$g'"
done <<< "$SITE_EXCLUDE_GLOBS"

echo "Deploying $SITE_LABEL"
echo "  from $SITE_SOURCE  to $FTP_PROTOCOL://$FTP_HOST:$FTP_PORT/$SITE_REMOTE"
[ -n "$SITE_DELETES" ] && echo "  mirror uses --delete; server-owned and secret paths are excluded"
[ -n "$DRY" ] && echo "  DRY RUN: nothing will be uploaded"

cd "$SRC"
# lftp echoes full URLs, credentials included, in --dry-run and on some errors.
# Everything it prints goes through a redactor so a password can never land in
# a terminal, a transcript or a log. The exit status is lftp's, not sed's.
SSL="set ftp:ssl-allow no"
[ -n "${FTP_TLS:-}" ] && SSL="set ftp:ssl-allow yes; set ftp:ssl-force yes; set ftp:ssl-protect-data yes; set ssl:verify-certificate no"
"$LFTP" -u "$FTP_USER,$FTP_PASSWORD" "$FTP_PROTOCOL://$FTP_HOST:$FTP_PORT" \
  -e "$SSL; set sftp:auto-confirm yes; set net:timeout 60; mirror $OPTS . '$SITE_REMOTE'; bye" 2>&1 \
  | sed -E 's#(://)[^/@[:space:]]+@#\1***@#g'
RC=${PIPESTATUS[0]}
[ "$RC" -eq 0 ] || { echo "lftp exited $RC" >&2; exit "$RC"; }

echo "Deploy complete: $SITE_LABEL"
