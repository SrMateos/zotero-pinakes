#!/bin/sh
# See run.sh: start Zotero with its output going to a log file.
exec "$PINAKES_REAL_ZOTERO" "$@" -ZoteroDebugText >"$PWD/.scaffold/test/zotero-output.log" 2>&1
