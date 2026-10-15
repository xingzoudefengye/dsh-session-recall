#!/usr/bin/env bash
# Turn on DeepSeek Harness's own workspace-authorized session history tools
# (`session_search`, `session_event_search`, `session_trace`,
# `session_event_trace`, `session_event_read`) for one profile.
#
# These tools ship with the harness but are left out of the composed profile:
# they are upstream's opt-in feature and cost fixed guidance plus five tool
# schemas on every model request. This script installs them at *your* harness
# version and mounts them in an isolated group, mirroring upstream's own
# `dsh-experimental-session-search` bundle patch.
#
# Usage: scripts/enable-read-tools.sh [profile]   (default: web)
set -euo pipefail

PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILES_DIR="$DSH_HOME/profiles"
PROFILE_DIR="$PROFILES_DIR/$PROFILE"

[ -d "$PROFILE_DIR" ] || { echo "no such profile: $PROFILE_DIR" >&2; exit 1; }

BASE="$PROFILES_DIR/node_modules/@deepseek-ai/dsh-base/package.json"
[ -f "$BASE" ] || { echo "cannot find the harness runtime at $BASE" >&2; exit 1; }
VERSION="$(node -p "require('$BASE').version")"
echo "harness runtime version: $VERSION"

echo "installing the two upstream packages at that exact version ..."
(cd "$PROFILE_DIR" && pnpm add "@deepseek-ai/dsh-tool-session-query@$VERSION" "@deepseek-ai/dsh-session-query-sqlite@$VERSION")

PATCH="$PROFILE_DIR/cordis.patch.yml"
[ -f "$PATCH" ] || printf '[]\n' > "$PATCH"

if grep -q "optional-tool-session-query" "$PATCH"; then
	echo "read tools are already mounted in $PATCH — nothing to do"
	exit 0
fi

cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)"

node - "$PATCH" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const path = process.argv[2];
const original = readFileSync(path, "utf8");

const block = `
# --- dsh-session-recall: upstream workspace-authorized session history tools ---
# Mounted in an isolated group, so this deployment's own sessionQuery row keeps
# its configuration; the group opens its own in-memory index on first search.
- insert:
    - id: optional-session-search
      name: cordis:group
      group: true
      isolate:
        sessionQuery: true
      config:
        - id: optional-session-query-sqlite
          name: '@deepseek-ai/dsh-session-query-sqlite'
          config:
            path: ':memory:'
            openAt: first-search
        - id: optional-tool-session-query
          name: '@deepseek-ai/dsh-tool-session-query'
`;

// The patch file is one top-level YAML sequence. A file holding only comments
// and an empty `[]` must have that marker removed, because appending after it
// would produce a second root node that cannot parse.
const body = original
	.split("\n")
	.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
	.join("\n")
	.trim();

const next =
	body === "" || body === "[]"
		? `${original
				.split("\n")
				.filter((line) => line.trim() === "" || line.trim().startsWith("#"))
				.join("\n")
				.trimEnd()}\n${block}`
		: `${original.trimEnd()}\n${block}`;
writeFileSync(path, next);
NODE

echo "mounted the read tools in $PATCH"
echo "restart the profile's app for the change to take effect."
