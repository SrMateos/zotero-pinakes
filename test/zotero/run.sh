#!/bin/sh
# Runs the integration tests (npm run test:zotero).
#
# zotero-plugin-scaffold reads Zotero's stdout but never its stderr. Once
# that pipe buffer fills up, Zotero blocks on its next write and the run
# hangs. So Zotero is started through zotero-quiet.sh, which sends all its
# output to .scaffold/test/zotero-output.log instead.
set -e
cd "$(dirname "$0")/../.."
from_env=$(sed -n 's/^ZOTERO_PLUGIN_ZOTERO_BIN_PATH *= *//p' .env 2>/dev/null || true)
PINAKES_REAL_ZOTERO="${PINAKES_REAL_ZOTERO:-${from_env:-$ZOTERO_PLUGIN_ZOTERO_BIN_PATH}}"
if [ -z "$PINAKES_REAL_ZOTERO" ]; then
  echo "Set ZOTERO_PLUGIN_ZOTERO_BIN_PATH in .env" >&2
  exit 1
fi
mkdir -p .scaffold/test
export PINAKES_REAL_ZOTERO
export ZOTERO_PLUGIN_ZOTERO_BIN_PATH="$PWD/test/zotero/zotero-quiet.sh"
exec npx zotero-plugin test --exit-on-finish "$@"
