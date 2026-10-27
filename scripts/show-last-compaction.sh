#!/usr/bin/env bash
# 显示某个会话最近一次压缩的接管内容，并判断交接里有没有「回合级史书」那一段。
# 用来确认 dsh-session-recall 的史书是否真的进了压缩交接（即 compaction 0.2.0 引擎生效）。
#
# 用法：
#   bash show-last-compaction.sh                # 在 dsh 会话里运行，取当前会话
#   bash show-last-compaction.sh <session-id>   # 指定会话
set -euo pipefail

SID="${1:-${DSH_SESSION_ID:-}}"
[ -n "$SID" ] || { echo "用法: $0 [session-id]  （在 dsh 会话内运行可省略）" >&2; exit 1; }

# 会话目录名带 `session-` 前缀，但日常复制到的往往是裸 UUID。
# 两种写法都接受：缺前缀就补上，多写了也不算错。
case "$SID" in
	session-*) ;;
	*) SID="session-$SID" ;;
esac

dir="$(find "$HOME/.dsh/sessions" -maxdepth 2 -type d -name "$SID" 2>/dev/null | head -1)"
[ -n "$dir" ] || { echo "找不到会话目录: $SID（传裸 UUID 也可以，会自动补 session- 前缀）" >&2; exit 1; }
log="$dir/session.v4.jsonl.zstd"
[ -f "$log" ] || { echo "找不到会话日志: $log" >&2; exit 1; }

# 先解压到临时文件再交给 python：不能给 python 同时喂 heredoc 和管道，
# heredoc 会覆盖 stdin，导致它永远读到空、永远报告"没有压缩记录"。
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
zstd -dc "$log" > "$tmp"

python3 - "$SID" "$tmp" <<'PY'
import sys, json, datetime, re

sid = sys.argv[1]
events = []
with open(sys.argv[2], encoding="utf-8") as source:
    for line in source:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") == "compaction/summary":
            events.append(e)

if not events:
    print(f"会话 {sid} 还没有任何压缩记录 —— 先在 GUI 里跑一次 /compact。")
    raise SystemExit(0)

# The chronicle section starts a line. Matching the bare phrase anywhere also
# hits prose that merely *mentions* it (and printed that prose as "the
# section"), so anchor it to the start of a line.
SECTION = re.compile(r"(?m)^回合级史书")


def texts(v):
    out = []
    if isinstance(v, dict):
        if v.get("type") == "text" and isinstance(v.get("text"), str):
            out.append(v["text"])
        for x in v.values():
            out += texts(x)
    elif isinstance(v, list):
        for x in v:
            out += texts(x)
    return out

print(f"会话 {sid}：共 {len(events)} 次压缩")
for i, e in enumerate(events, 1):
    d = e["data"]
    t = "\n".join(texts(d))
    ts = datetime.datetime.fromtimestamp(e["time"] / 1000).strftime("%m-%d %H:%M:%S")
    print(
        f"  #{i} {ts} seq={e['seq']} provider={d.get('provider')} "
        f"替换 {d.get('shadowedTokenCount')} tokens 交接 {len(t)} 字符 "
        f"史书段={'有' if SECTION.search(t) else '无'}"
    )

last = "\n".join(texts(events[-1]["data"]))
found = SECTION.search(last)
print()
if found:
    print("结论：最新一次压缩的交接里【有】回合级史书 —— 0.2.0 引擎已在运行进程里生效。")
    print("---- 那一段 ----")
    print(last[found.start() : found.start() + 700])
else:
    print("结论：最新一次压缩的交接里【没有】回合级史书。")
    print("  可能原因：(a) 这次压缩发生在 0.2.0 安装之前（09:07 之前）；(b) 运行中的进程仍加载着旧的引擎模块。")
    print("  判定：看上面那次压缩的时间。若在引擎安装之后仍没有，重启 dsh web 即可生效。")
PY
