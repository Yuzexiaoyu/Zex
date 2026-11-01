"""Read-only cover inventory and get_stats ranking/source mirror; no native IPC."""
import argparse
import collections
import hashlib
import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("data_dir", type=Path)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
data_dir = args.data_dir.resolve()
database = data_dir / "zex.db"
connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
connection.execute("PRAGMA query_only = ON")
connection.execute("BEGIN")
queries = {
    "game": "SELECT cover_path, banner_path FROM games WHERE hidden = 0",
    "video": "SELECT poster_path, bg_path FROM series",
    "music": "SELECT cover_path, '' FROM tracks",
}
report = {
    "generated_at": datetime.now(timezone(timedelta(hours=8))).isoformat(),
    "database": str(database),
    "database_mode": "ro, query_only, read transaction",
    "scope": "Library cover inventory, including unplayed entries; excludes stats_archive and Steam official-header overrides in get_stats.",
    "media": {},
    "audit_script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
}


def profile(rows):
    sources = set(wide or cover for cover, wide in rows if wide or cover)
    images, missing, unreadable = [], [], []
    for source in sorted(sources):
        # The production covers protocol resolves the requested path to its basename.
        path = data_dir / "covers" / Path(source).name
        if not path.is_file():
            missing.append(path.name)
            continue
        try:
            with Image.open(path) as image:
                images.append({
                    "file": path.name, "width": image.width, "height": image.height,
                    "format": image.format, "compressed_bytes": path.stat().st_size,
                    "rgba_bytes": image.width * image.height * 4,
                    "progressive": bool(image.info.get("progressive") or image.info.get("progression")),
                })
        except Exception as error:
            unreadable.append({"file": path.name, "reason": str(error)})
    return {
        "row_count": len(rows), "unique_selected_sources": len(sources),
        "readable": len(images), "missing": missing, "unreadable": unreadable,
        "compressed_bytes": sum(image["compressed_bytes"] for image in images),
        "rgba_bytes_if_all_decoded": sum(image["rgba_bytes"] for image in images),
        "larger_than_256": sum(max(image["width"], image["height"]) > 256 for image in images),
        "larger_than_1024": sum(max(image["width"], image["height"]) > 1024 for image in images),
        "progressive": sum(image["progressive"] for image in images),
        "most_common_dimensions": collections.Counter((image["width"], image["height"]) for image in images).most_common(5),
        "largest": sorted(images, key=lambda image: image["rgba_bytes"], reverse=True)[:5],
    }


for media, query in queries.items():
    report["media"][media] = profile(connection.execute(query).fetchall())

# Extract the SELECT templates from get_stats, including archive deduplication and
# the watched-episode duration expression. Do not invent a similar ranking query.
stats_source_path = Path("src-tauri/src/stats.rs")
stats_source_bytes = stats_source_path.read_bytes()
stats_source = stats_source_bytes.decode("utf-8")
templates = re.findall(r'"(SELECT id, name, sub, cover_path, wide_path, seconds, count(?:, ext_id)? FROM \([\s\S]*?ORDER BY seconds DESC LIMIT \{WALL_LIMIT\})"', stats_source)
if len(templates) != 3:
    raise RuntimeError("Expected the three current get_stats ranking SELECT templates")
substitutions = dict(re.findall(r'let (game_gone|video_gone|music_gone) = "([^"]+)";', stats_source))
substitutions["WALL_LIMIT"] = re.search(r"const WALL_LIMIT: i64 = (\d+);", stats_source).group(1)
duration = re.search(r'"(CASE WHEN \{a\}\.media_type[\s\S]*?)",\s*a = alias', stats_source).group(1)
substitutions["dur"] = duration.replace("{a}", "s")
report["stats_source"] = {"file": str(stats_source_path), "sha256": hashlib.sha256(stats_source_bytes).hexdigest(), "sql": {}}
report["stats_top"] = {}
for media, template in zip(["game", "video", "music"], templates):
    sql = template
    for name, value in substitutions.items():
        sql = sql.replace("{" + name + "}", value)
    report["stats_source"]["sql"][media] = sql
    selected = []
    for row in connection.execute(sql).fetchall():
        cover, wide = row[3] or "", row[4] or ""
        if media == "game" and row[7] > 0:
            appid = row[7]
            wide_path = Path(wide)
            custom = bool(wide) and wide_path.is_file() and wide_path.name not in {f"banner_{appid}.jpg", f"banner_{appid}_og.jpg"}
            header = data_dir / "covers" / f"banner_{appid}.jpg"
            if not custom and header.is_file():
                wide = str(header)
        selected.append((cover, wide))
    report["stats_top"][media] = profile(selected)
report["stats_top_scope"] = "Current get_stats SQL templates and Steam banner selection mirrored against a read-only snapshot; no native IPC or rendering measurement."
connection.rollback()
connection.close()
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"library": {media: {key: value for key, value in summary.items() if key not in {"missing", "unreadable", "largest"}} for media, summary in report["media"].items()}, "stats_top": {media: {key: value for key, value in summary.items() if key not in {"missing", "unreadable", "largest"}} for media, summary in report["stats_top"].items()}}, ensure_ascii=False))
