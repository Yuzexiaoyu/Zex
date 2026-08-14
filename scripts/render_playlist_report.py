# -*- coding: utf-8 -*-
"""读取 data/mpv/queue.m3u + queue.json，生成播放列表 HTML 报告。"""
import json
import html
import collections

DATA = r"D:\ZEX\src-tauri\target\debug\data\mpv"
OUT = r"D:\ZEX\playlist-report.html"

with open(DATA + r"\queue.json", encoding="utf-8") as f:
    q = json.load(f)
items = q["items"]

with open(DATA + r"\queue.m3u", encoding="utf-8") as f:
    paths = [line for line in f.read().splitlines() if line and not line.startswith("#")]
assert len(paths) == len(items), (len(paths), len(items))

by_season = collections.OrderedDict()
for i, it in enumerate(items):
    by_season.setdefault(it["s"], []).append((i, it, paths[i]))

total = len(items)
watched = sum(1 for it in items if it["w"])
inprog = sum(1 for it in items if not it["w"] and it["ms"] > 0)
# 当前播放集（来自最新 series_sessions：S01E03）
current = next((i for i, it in enumerate(items) if it["s"] == 1 and it["e"] == 3), -1)

dup_counter = collections.Counter((it["s"], it["e"]) for it in items)
dup_keys = sorted(k for k, v in dup_counter.items() if v > 1)
dup_idx = [i for i, it in enumerate(items) if (it["s"], it["e"]) in set(dup_keys)]


def fmt_ms(ms):
    return "%d:%02d" % (ms // 60000, ms // 1000 % 60)


rows = []
for s, eps in by_season.items():
    w = sum(1 for _, it, _ in eps if it["w"])
    rows.append(
        '<tr class="season"><td colspan="5">第 %d 季 <span class="sub">共 %d 集 · 已看 %d</span></td></tr>'
        % (s, len(eps), w)
    )
    for idx, it, path in eps:
        dur = it["rt"] * 60 * 1000 if it["rt"] else 0
        pct = min(100.0, it["ms"] / dur * 100) if dur else 0.0
        if it["w"]:
            badge, cls = "已看", "ok"
        elif it["ms"] > 0:
            badge, cls = "看到 %s (%.0f%%)" % (fmt_ms(it["ms"]), pct), "prog"
        else:
            badge, cls = "未看", "no"
        cur = '<span class="cur">▶ 正在播放</span>' if idx == current else ""
        playing_cls = "playing" if idx == current else ""
        fname = html.escape(path.split("/")[-1])
        rows.append(
            '<tr class="%s"><td class="idx">%d</td><td class="ep">S%02dE%02d</td>'
            '<td class="title">%s %s</td>'
            '<td><span class="badge %s">%s</span>'
            '<div class="bar"><div class="fill" style="width:%.1f%%"></div></div></td>'
            '<td class="path">%s</td></tr>'
            % (playing_cls, idx, it["s"], it["e"], html.escape(it["t"]), cur,
               cls, badge, pct, fname)
        )

dup_text = " / ".join("S%02dE%02d" % k for k in dup_keys)
warn = ""
if dup_keys:
    warn = ('<div class="warn">⚠️ 检测到重复条目：%s 各出现 2 次'
            "（不同片源版本同时入库），列表下标 %s。</div>") % (dup_text, dup_idx)

CSS = """
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Segoe UI','Microsoft YaHei',sans-serif; background:#f5f7fa; color:#1f2329; padding:32px; }
h1 { font-size:22px; margin-bottom:6px; }
.meta { color:#6b7280; font-size:13px; margin-bottom:20px; }
.cards { display:flex; gap:14px; margin-bottom:24px; flex-wrap:wrap; }
.card { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:14px 20px; min-width:140px; }
.card .n { font-size:26px; font-weight:700; }
.card .l { font-size:12px; color:#6b7280; margin-top:2px; }
table { width:100%; border-collapse:collapse; background:#fff; border-radius:10px; overflow:hidden; border:1px solid #e5e7eb; }
th { background:#eef2f7; text-align:left; font-size:12px; color:#6b7280; padding:10px 12px; }
td { padding:8px 12px; border-top:1px solid #f0f1f3; font-size:13px; vertical-align:middle; }
tr.season td { background:#e8eef7; font-weight:700; color:#1d4ed8; }
tr.season .sub { font-weight:400; color:#64748b; font-size:12px; margin-left:8px; }
tr.playing td { background:#fff7e6; }
td.idx { color:#9ca3af; width:48px; }
td.ep { font-variant-numeric:tabular-nums; white-space:nowrap; font-weight:600; }
td.title { min-width:220px; }
td.path { color:#9ca3af; font-size:11px; max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.badge { display:inline-block; padding:2px 8px; border-radius:99px; font-size:11px; white-space:nowrap; }
.badge.ok { background:#dcfce7; color:#15803d; }
.badge.prog { background:#fef9c3; color:#a16207; }
.badge.no { background:#f3f4f6; color:#9ca3af; }
.bar { height:4px; background:#eef0f2; border-radius:2px; margin-top:5px; width:140px; }
.fill { height:100%; background:#3b82f6; border-radius:2px; }
.cur { color:#d97706; font-weight:700; font-size:12px; margin-left:8px; }
.warn { background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:18px; }
"""

doc = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>ZEX 播放器播放列表</title>
<style>%s</style></head><body>
<h1>🎬 ZEX 播放器 · 当前播放列表</h1>
<div class="meta">来源：data/mpv/queue.m3u + queue.json ｜ 快照时间：2026-08-05 17:44 ｜ mpv 正在运行中</div>
<div class="cards">
  <div class="card"><div class="n">%d</div><div class="l">列表总条目</div></div>
  <div class="card"><div class="n">%d</div><div class="l">覆盖季数 (S01–S22)</div></div>
  <div class="card"><div class="n" style="color:#15803d">%d</div><div class="l">已看完</div></div>
  <div class="card"><div class="n" style="color:#a16207">%d</div><div class="l">看到一半</div></div>
  <div class="card"><div class="n" style="color:#d97706">S01E03</div><div class="l">正在播放</div></div>
</div>
%s
<table>
<thead><tr><th>#</th><th>季集</th><th>标题</th><th>观看状态 / 进度</th><th>文件名</th></tr></thead>
<tbody>
%s
</tbody></table>
</body></html>""" % (CSS, total, len(by_season), watched, inprog, warn, "".join(rows))

with open(OUT, "w", encoding="utf-8") as f:
    f.write(doc)
print("written:", OUT, len(doc), "bytes")
