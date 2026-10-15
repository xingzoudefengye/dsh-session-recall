#!/usr/bin/env bash
# Verify one profile's session-recall wiring:
#   1. the bounded chronicle's two rows are present in the composed tree;
#   2. if the upstream read tools are mounted, both packages are installed at
#      exactly the harness's own version.
#
# Usage: scripts/check.sh [profile]   (default: web)
set -euo pipefail

PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILES_DIR="$DSH_HOME/profiles"
PROFILE_DIR="$PROFILES_DIR/$PROFILE"

[ -d "$PROFILE_DIR" ] || { echo "FAIL: no such profile: $PROFILE_DIR" >&2; exit 1; }

DUMP="$(mktemp)"
trap 'rm -f "$DUMP"' EXIT
dsh --profile "$PROFILE" --dump-config > "$DUMP"

status=0

for row in session-chronicle tool-session-chronicle; do
	if grep -q "id: $row" "$DUMP"; then
		echo "ok:   $row is in the composed tree"
	else
		echo "FAIL: $row is missing — install this bundle: dsh plugin --profile $PROFILE add github:xingzoudefengye/dsh-session-recall"
		status=1
	fi
done

if grep -q "optional-tool-session-query" "$DUMP"; then
	BASE="$PROFILES_DIR/node_modules/@deepseek-ai/dsh-base/package.json"
	VERSION="$(node -p "require('$BASE').version")"
	echo "ok:   upstream read tools are mounted (harness $VERSION)"
	for pkg in dsh-tool-session-query dsh-session-query-sqlite; do
		manifest="$PROFILE_DIR/node_modules/@deepseek-ai/$pkg/package.json"
		[ -f "$manifest" ] || manifest="$PROFILES_DIR/node_modules/@deepseek-ai/$pkg/package.json"
		if [ ! -f "$manifest" ]; then
			echo "FAIL: @deepseek-ai/$pkg is not installed in this profile"
			status=1
			continue
		fi
		installed="$(node -p "require('$manifest').version")"
		if [ "$installed" = "$VERSION" ]; then
			echo "ok:   @deepseek-ai/$pkg@$installed matches the harness"
		else
			echo "FAIL: @deepseek-ai/$pkg@$installed does not match the harness ($VERSION) — re-run scripts/enable-read-tools.sh $PROFILE"
			status=1
		fi
	done
else
	echo "note: upstream read tools are not mounted (run scripts/enable-read-tools.sh $PROFILE to add them)"
fi

exit "$status"
