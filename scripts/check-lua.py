#!/usr/bin/env python
"""把 modernz.lua 丢进随包的 mpv 里跑一遍，看有没有语法/运行时错误。

mpv 没有「只检查脚本」的模式，所以这里让它 --idle=yes 空跑几秒，
把日志写到临时文件再筛 Lua 报错。脚本加载失败/报错都会出现在日志里。

用法：python scripts/check-lua.py [脚本路径...]
不给参数就检查 skin/scripts 下全部 .lua。
"""
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MPV = os.path.join(ROOT, "src-tauri", "resources", "mpv", "mpv.exe")
SCRIPTS_DIR = os.path.join(ROOT, "src-tauri", "resources", "skin", "scripts")

# 只认真正的错误级日志和 Lua traceback，别被 [w] 警告和功能列表噪音带偏
ERROR_RE = re.compile(
    r"\]\[e\]|stack traceback|attempt to (index|call|compare|perform)"
    r"|\.lua:\d+:|syntax error|Lua error",
    re.IGNORECASE,
)


def check(path):
    if not os.path.exists(path):
        print("跳过（不存在）: %s" % path)
        return True
    with tempfile.NamedTemporaryFile(suffix=".log", delete=False) as f:
        log = f.name
    try:
        subprocess.run(
            [MPV, "--no-config", "--script=" + path.replace("\\", "/"),
             "--idle=yes", "--vo=null", "--ao=null",
             "--log-file=" + log.replace("\\", "/")],
            capture_output=True, timeout=10, stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        pass  # idle 模式本来就不会自己退出，超时是预期的
    with open(log, "r", encoding="utf-8", errors="replace") as f:
        hits = [ln.rstrip() for ln in f if ERROR_RE.search(ln)]
    os.unlink(log)
    name = os.path.basename(path)
    if hits:
        print("FAIL %s" % name)
        for h in hits[:20]:
            print("   " + h)
        return False
    print("OK   %s" % name)
    return True


def main():
    if not os.path.exists(MPV):
        print("找不到 mpv.exe（先跑 scripts/fetch-mpv.sh）: %s" % MPV)
        return 1
    targets = sys.argv[1:] or sorted(
        os.path.join(SCRIPTS_DIR, n)
        for n in os.listdir(SCRIPTS_DIR)
        if n.endswith(".lua")
    )
    return 0 if all([check(t) for t in targets]) else 1


if __name__ == "__main__":
    sys.exit(main())
