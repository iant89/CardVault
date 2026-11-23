"""Training data: exported lines, augmentation that mimics phone captures, and
synthetic lines rendered from card-name lists.

The preprocessing here MUST match CardVault's `lineTensor()` in
packages/imaging/src/index.ts: grayscale, 32 px tall, width scaled to keep the
aspect ratio (8..512), values in [-1, 1].
"""
from __future__ import annotations

import glob
import io
import json
import os
import random
from dataclasses import dataclass

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

LINE_HEIGHT = 32
LINE_MAX_WIDTH = 512

# characters a collector number can contain (as CardVault restricts number spots)
NUMBER_CHARS = set("0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ- ")
BASE_CHARSET = (
    "0123456789"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    " '’-.,:/&!?()é♂♀"
)


def fnv1a(s: str) -> int:
    """32-bit FNV-1a over code points: a stable hash for the dev split."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch) & 0xFFFF
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def to_tensor(img: Image.Image) -> torch.Tensor:
    """Grayscale line image → [1, 32, W] in [-1, 1]."""
    g = img.convert("L")
    w = max(8, min(LINE_MAX_WIDTH, round(g.width * LINE_HEIGHT / max(1, g.height))))
    g = g.resize((w, LINE_HEIGHT), Image.BILINEAR)
    a = np.asarray(g, dtype=np.float32) / 127.5 - 1.0
    return torch.from_numpy(a).unsqueeze(0)


def augment(img: Image.Image, rng: random.Random) -> Image.Image:
    """Make a clean line look like it came from a hand-held phone photo."""
    img = img.convert("RGB")
    w, h = img.size
    # framing jitter: the crop never lands exactly on the text
    dx0, dx1 = (rng.randint(-int(w * 0.04), int(w * 0.06)) for _ in range(2))
    dy0, dy1 = (rng.randint(-int(h * 0.08), int(h * 0.12)) for _ in range(2))
    img = img.crop((max(0, dx0), max(0, dy0), min(w, w - dx1) if w - dx1 > dx0 + 8 else w, min(h, h - dy1) if h - dy1 > dy0 + 6 else h))
    if rng.random() < 0.4:
        img = img.rotate(rng.uniform(-2.0, 2.0), resample=Image.BILINEAR, expand=False, fillcolor=img.getpixel((0, 0)))
    # low resolution: shrink and blow back up
    if rng.random() < 0.6:
        f = rng.uniform(0.35, 0.9)
        small = img.resize((max(4, int(img.width * f)), max(4, int(img.height * f))), Image.BILINEAR)
        img = small.resize(img.size, Image.BILINEAR)
    if rng.random() < 0.5:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 1.1)))
    img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.65, 1.35))
    img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.6, 1.4))
    if rng.random() < 0.5:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=rng.randint(35, 92))
        img = Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
    if rng.random() < 0.4:
        a = np.asarray(img, dtype=np.float32)
        a += np.random.default_rng(rng.randint(0, 2**31)).normal(0, rng.uniform(2, 10), a.shape)
        img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    return img


@dataclass
class Line:
    image: Image.Image | None
    path: str | None
    text: str
    field: str
    weight: float
    group: str
    source: str


def load_export(dataset_dir: str, storage: str) -> tuple[list[Line], dict]:
    # exports always carry non-ASCII (· in counts, accented names): read as UTF-8
    # whatever the machine's locale says
    with open(os.path.join(dataset_dir, "info.json"), encoding="utf-8") as f:
        info = json.load(f)
    lines: list[Line] = []
    missing = 0
    bad = 0
    with open(os.path.join(dataset_dir, "train.jsonl"), encoding="utf-8") as f:
        for raw in f:
            if not raw.strip():
                continue
            try:
                r = json.loads(raw)
                crop, text, field = r["crop"], r["text"], r["field"]
            except (ValueError, TypeError, KeyError):
                bad += 1  # a truncated row from an interrupted write: skip, don't die
                continue
            if not text:
                continue
            p = os.path.join(storage, crop)
            if not os.path.exists(p):
                missing += 1
                continue
            lines.append(Line(None, p, text, field, float(r.get("weight") or 1), r.get("group") or "", r.get("source") or ""))
    if bad:
        print(f"  {bad} rows in train.jsonl are malformed (skipped)")
    if missing:
        print(f"  {missing} crops listed in the export are missing on disk (skipped)")
    return lines, info


def find_fonts() -> list[str]:
    pats = ["/usr/share/fonts/**/*.ttf", "/usr/share/fonts/**/*.otf", "/usr/local/share/fonts/**/*.ttf", os.path.expanduser("~/.fonts/**/*.ttf"), "/System/Library/Fonts/**/*.ttf", "C:/Windows/Fonts/*.ttf"]
    fonts = sorted({f for p in pats for f in glob.glob(p, recursive=True)})
    # text faces only: skip symbol/emoji/monospace-only oddities
    keep = [f for f in fonts if not any(x in os.path.basename(f).lower() for x in ("emoji", "symbol", "dingbat", "math", "braille", "icon"))]
    return keep


class Synthetic:
    """Renders card names and collector numbers onto patches of real crops."""

    def __init__(self, fonts: list[str], names: list[str], backgrounds: list[str], seed: int = 7):
        self.fonts = fonts
        self.names = [n for n in names if 2 <= len(n) <= 40]
        self.backgrounds = backgrounds
        self.rng = random.Random(seed)

    def number_text(self) -> str:
        r = self.rng
        kind = r.random()
        if kind < 0.75:
            total = r.randint(30, 300)
            n = r.randint(1, total + 40)
            return f"{n:03d}/{total:03d}"
        if kind < 0.85:
            total = r.randint(60, 150)
            return f"{r.randint(1, total)}/{total}"
        if kind < 0.93:
            p = r.choice(["TG", "GG", "SV", "RC", "H"])
            t = r.randint(20, 70)
            return f"{p}{r.randint(1, t):02d}/{p}{t}"
        return f"{r.choice(['SWSH', 'SVP', 'SM', 'XY'])}{r.randint(1, 299):03d}"

    def render(self) -> Line:
        r = self.rng
        # no usable names (number-only dataset, empty name lists): always draw a number
        field = "number" if r.random() < 0.4 or not self.names else "name"
        text = self.number_text() if field == "number" else r.choice(self.names)
        font_path = r.choice(self.fonts)
        size = r.randint(22, 40)
        try:
            font = ImageFont.truetype(font_path, size)
        except OSError:
            font = ImageFont.load_default()
        box = font.getbbox(text)
        tw, th = box[2] - box[0], box[3] - box[1]
        pad_x, pad_y = r.randint(4, 30), r.randint(4, 12)
        W, H = tw + pad_x * 2 + r.randint(0, 40), th + pad_y * 2
        bg = Image.open(r.choice(self.backgrounds)).convert("RGB").resize((W, H), Image.BILINEAR) if self.backgrounds else Image.new("RGB", (W, H), (200, 200, 200))
        if r.random() < 0.6:  # usually a light text band behind the text, like real cards
            band = Image.new("RGB", (W, H), tuple(r.randint(200, 250) for _ in range(3)))
            bg = Image.blend(bg, band, r.uniform(0.5, 0.95))
        lum = np.asarray(bg.convert("L"), dtype=np.float32).mean()
        ink = tuple(r.randint(0, 60) for _ in range(3)) if lum > 120 else tuple(r.randint(200, 255) for _ in range(3))
        d = ImageDraw.Draw(bg)
        d.text((pad_x - box[0], pad_y - box[1]), text, font=font, fill=ink)
        return Line(bg, None, text, field, 1.0, f"synthetic:{r.random()}", "synthetic")


class LineDataset(torch.utils.data.Dataset):
    def __init__(self, lines: list[Line], charset: str, train: bool, synthetic: Synthetic | None = None, synthetic_count: int = 0, seed: int = 1):
        self.lines = lines
        self.index = {c: i + 1 for i, c in enumerate(charset)}  # 0 = CTC blank
        self.train = train
        self.synthetic = synthetic
        self.synthetic_count = synthetic_count if synthetic else 0
        self.seed = seed

    @property
    def paths(self) -> list[str | None]:
        """Crop path of each real line (None for synthetic): lets reports show the line itself."""
        return [ln.path for ln in self.lines]

    def __len__(self) -> int:
        return len(self.lines) + self.synthetic_count

    def encode(self, text: str) -> list[int]:
        return [self.index[c] for c in text if c in self.index]

    def __getitem__(self, i: int):
        rng = random.Random(self.seed * 1_000_003 + i + (random.random() * 1e9 if self.train else 0))
        if i < len(self.lines):
            ln = self.lines[i]
            img = Image.open(ln.path).convert("RGB") if ln.path else ln.image
        else:
            ln = self.synthetic.render()
            img = ln.image
        if self.train:
            img = augment(img, rng)
        x = to_tensor(img)
        return x, torch.tensor(self.encode(ln.text), dtype=torch.long), ln.text, ln.field, ln.weight


def collate(batch):
    xs, ys, texts, fields, weights = zip(*batch)
    width = max(x.shape[-1] for x in xs)
    img = torch.full((len(xs), 1, LINE_HEIGHT, width), 0.0)
    for k, x in enumerate(xs):
        img[k, :, :, : x.shape[-1]] = x
        if x.shape[-1] < width:  # pad by repeating the last column (no fake edge)
            img[k, :, :, x.shape[-1]:] = x[:, :, -1:]
    widths = torch.tensor([x.shape[-1] for x in xs])
    targets = torch.cat(ys) if ys else torch.zeros(0, dtype=torch.long)
    lengths = torch.tensor([len(y) for y in ys])
    return img, widths, targets, lengths, list(texts), list(fields), torch.tensor(weights)
