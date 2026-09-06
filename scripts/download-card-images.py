#!/usr/bin/env python3
"""下载 PTCGL 当前赛制(F-J)全部卡图的低清版到本地缓存。

用法(在仓库根目录):
  python scripts/download-card-images.py            # 全量下载(约 5853 张, ~170-380MB)
  python scripts/download-card-images.py --limit 50 # 试跑 50 张

特性: 16 线程并发 / 失败重试 / 断点续传(已存在的跳过) / 进度显示
有 Pillow 时转 webp(约省一半体积), 没有 Pillow 则保存原始 png。
完成后生成 data/full-images.json 清单, 网页端会自动优先使用本地卡图。
"""
import json
import sys
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "data" / "cards-full.json"
OUT_DIR = ROOT / "assets" / "cards-full"
MANIFEST = ROOT / "data" / "full-images.json"
ROTATION = {"F", "G", "H", "I", "J"}
THREADS = 16
RETRIES = 3
TIMEOUT = 60

try:
    from PIL import Image
    import io
    import warnings
    warnings.filterwarnings("ignore")
    USE_WEBP = True
except ImportError:
    USE_WEBP = False

EXT = "webp" if USE_WEBP else "png"


def fetch(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": "ptcgl-replay-img-cache/1.0"})
    with urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def to_webp(raw: bytes) -> bytes:
    im = Image.open(io.BytesIO(raw))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA") if "transparency" in im.info else im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=82)
    return buf.getvalue()


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    index = json.load(open(INDEX, encoding="utf-8"))
    records = []
    for name, printings in index["cards"].items():
        for c in printings:
            if (c.get("regulationMark") or "").upper() in ROTATION and c.get("image"):
                records.append(c)
    # 去重(同名不同印刷都要, id 唯一)
    seen, uniq = set(), []
    for c in records:
        if c["id"] not in seen:
            seen.add(c["id"])
            uniq.append(c)
    records = uniq
    if limit:
        records = records[:limit]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    todo = [c for c in records if not (OUT_DIR / f"{c['id']}.{EXT}").exists()]
    print(f"目标 {len(records)} 张, 已存在 {len(records) - len(todo)} 张, 本次下载 {len(todo)} 张, 格式 {EXT}", flush=True)
    if not todo:
        write_manifest(records)
        return

    t0 = time.time()
    done = fail = 0

    def work(card):
        url = card["image"].replace("/high.png", "/low.png")
        out = OUT_DIR / f"{card['id']}.{EXT}"
        for attempt in range(RETRIES):
            try:
                raw = fetch(url)
                data = to_webp(raw) if USE_WEBP else raw
                out.write_bytes(data)
                return True
            except Exception as e:
                if attempt == RETRIES - 1:
                    print(f"\nFAIL {card['id']} {url}: {e}", flush=True)
                    return False
                time.sleep(1.5 * (attempt + 1))
        return False

    with ThreadPoolExecutor(max_workers=THREADS) as ex:
        for ok in ex.map(work, todo):
            done += 1
            fail += (not ok)
            if done % 200 == 0 or done == len(todo):
                rate = done / max(1e-9, time.time() - t0)
                eta = (len(todo) - done) / rate if rate > 0 else 0
                print(f"  {done}/{len(todo)} 失败 {fail} · {rate:.1f} 张/s · 剩余约 {eta/60:.1f} 分钟", flush=True)

    write_manifest(records)
    print(f"完成: 成功 {done - fail}, 失败 {fail}, 目录 {OUT_DIR}", flush=True)


def write_manifest(records):
    ids = [c["id"] for c in records if (OUT_DIR / f"{c['id']}.{EXT}").exists()]
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    json.dump({"format": EXT, "ids": ids}, open(MANIFEST, "w", encoding="utf-8"))
    total_mb = sum(f.stat().st_size for f in OUT_DIR.glob(f"*.{EXT}")) / 1048576
    print(f"清单已写入 {MANIFEST} · 共 {len(ids)} 张 · {total_mb:.0f} MB", flush=True)


if __name__ == "__main__":
    main()
