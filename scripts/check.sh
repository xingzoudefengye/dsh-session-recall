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
# Windows 的 node 不认 MSYS 的 /c/... 路径（require 会拼成 C:Users\uogu... 那种坏路径），
# 所以凡是把脚本里的路径交给 node 读，都先经 cygpath 转成原生形式；
# 路径通过 argv 传，不拼进 JS 源码，免得反斜杠被当转义。
node_require_version() {
	local p="$1"
	if command -v cygpath >/dev/null 2>&1; then
		p="$(cygpath -w "$p")"
	fi
	node -e 'process.stdout.write(require(process.argv[1]).version)' "$p"
}
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
	# 见 enable-read-tools.sh：runtime 未必在 profiles/node_modules 下，
	# 找不到就退回 CLI 版本，避免整个 check 因路径假设而崩掉（2026-11-02 实测）。
	BASE="$PROFILES_DIR/node_modules/@deepseek-ai/dsh-base/package.json"
	[ -f "$BASE" ] || BASE="$PROFILE_DIR/node_modules/@deepseek-ai/dsh-base/package.json"
	if [ -f "$BASE" ]; then
		VERSION="$(node_require_version "$BASE")"
	else
		VERSION="$(dsh --version 2>/dev/null || echo unknown)"
	fi
	echo "ok:   upstream read tools are mounted (harness $VERSION)"
	for pkg in dsh-tool-session-query dsh-session-query-sqlite; do
		manifest="$PROFILE_DIR/node_modules/@deepseek-ai/$pkg/package.json"
		[ -f "$manifest" ] || manifest="$PROFILES_DIR/node_modules/@deepseek-ai/$pkg/package.json"
		if [ ! -f "$manifest" ]; then
			echo "FAIL: @deepseek-ai/$pkg is not installed in this profile"
			status=1
			continue
		fi
		installed="$(node_require_version "$manifest")"
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
