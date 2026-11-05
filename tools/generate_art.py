"""Генерация арта «Кости и Факел» через OpenAI Images API (запускается в GitHub Actions).

Читает tools/art-manifest.json и пишет готовые файлы:
  mini -> 256x384 RGBA PNG: фигура обрезана по альфе, по центру, ноги у нижнего края (96%)
Оригиналы — в art-source/ (не в git, выгружаются артефактом сборки).

    OPENAI_API_KEY=... python tools/generate_art.py --keys guardian,rat_swarm
    OPENAI_API_KEY=... python tools/generate_art.py --kind mini
    python tools/generate_art.py --keys guardian --from-file img.png   # только обработка

Основа — конвейер IRON FRONT. Модель по умолчанию gpt-image-2.5-flare (gpt-image-1 отключена 2026-10-23).
"""
import argparse, base64, io, json, os, sys, time
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "tools/art-manifest.json"
SOURCE = ROOT / "art-source"
API = "https://api.openai.com/v1/images/generations"
SIZE = {"mini": "1024x1536"}
MINI_W, MINI_H, FEET = 256, 384, 0.96


def generate(prompt, kind, model, quality):
    import requests
    body = {"model": model, "prompt": prompt, "size": SIZE[kind], "quality": quality, "n": 1,
            "background": "transparent", "output_format": "png"}
    for attempt in range(4):
        r = requests.post(API, timeout=300, json=body,
                          headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"})
        if r.status_code == 200:
            return base64.b64decode(r.json()["data"][0]["b64_json"])
        if r.status_code in (429, 500, 502, 503) and attempt < 3:
            time.sleep(10 * (attempt + 1))
            continue
        raise RuntimeError(f"OpenAI {r.status_code}: {r.text[:400]}")


def fit_mini(img):
    """Обрезка по фигуре, вписывание в 256x384, ноги на 96% высоты, по центру."""
    img = img.convert("RGBA")
    box = img.getchannel("A").point(lambda a: 255 if a > 24 else 0).getbbox()
    if not box:
        raise ValueError("image is fully transparent")
    fig = img.crop(box)
    feet_y = round(MINI_H * FEET)
    scale = min((MINI_W * 0.94) / fig.width, (feet_y - 4) / fig.height)
    fig = fig.resize((max(1, round(fig.width * scale)), max(1, round(fig.height * scale))), Image.LANCZOS)
    out = Image.new("RGBA", (MINI_W, MINI_H), (0, 0, 0, 0))
    out.alpha_composite(fig, ((MINI_W - fig.width) // 2, feet_y - fig.height))
    return out


def save(entry, raw):
    out = fit_mini(Image.open(io.BytesIO(raw)))
    path = ROOT / entry["path"]
    path.parent.mkdir(parents=True, exist_ok=True)
    out.save(path, "PNG", optimize=True)
    return path, out.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keys", default="")
    ap.add_argument("--kind", default="")
    ap.add_argument("--quality", default="medium", choices=["low", "medium", "high"])
    ap.add_argument("--model", default="gpt-image-2.5-flare")
    ap.add_argument("--from-file")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    items = json.loads(MANIFEST.read_text())
    keys = {k.strip() for k in a.keys.split(",") if k.strip()}
    chosen = [e for e in items if (not keys or e["key"] in keys) and (not a.kind or e["kind"] == a.kind)]
    unknown = keys - {e["key"] for e in items}
    if unknown:
        sys.exit(f"Unknown keys: {', '.join(sorted(unknown))}")
    if not chosen:
        sys.exit("Nothing selected: pass --keys and/or --kind")
    if a.dry_run:
        for e in chosen:
            print(e["key"], "->", e["path"])
        return
    if not a.from_file and not os.environ.get("OPENAI_API_KEY"):
        sys.exit("OPENAI_API_KEY is not set")
    SOURCE.mkdir(exist_ok=True)
    failures = []
    for e in chosen:
        try:
            raw = Path(a.from_file).read_bytes() if a.from_file else generate(e["prompt"], e["kind"], a.model, a.quality)
            (SOURCE / f"{e['key']}.png").write_bytes(raw)
            path, size = save(e, raw)
            print(f"OK   {e['key']:16} {size[0]}x{size[1]} -> {path.relative_to(ROOT)}", flush=True)
        except Exception as exc:
            failures.append(e["key"])
            print(f"FAIL {e['key']:16} {exc}", flush=True)
    if failures:
        sys.exit(f"{len(failures)} failed: {', '.join(failures)}")


if __name__ == "__main__":
    main()
