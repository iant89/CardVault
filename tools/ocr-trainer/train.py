#!/usr/bin/env python3
"""Train CardVault's line reader on an exported dataset and write an ONNX model
CardVault can score and, if it passes the exam gates, promote.

  python tools/ocr-trainer/train.py --storage /path/to/cardvault/storage

Reads   <storage>/ocr/datasets/<id>/{train.jsonl, info.json}   (OCR Lab → Export training data)
Writes  <storage>/ocr/models/<model id>/{model.onnx, card.json}

The frozen exam is never seen here: exports contain training-side lines only.
A small dev slice of the training data (by card group) is held back to pick
the best epoch; the real verdict comes from CardVault's exam.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time

import numpy as np
import torch
from torch import nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ocrtrainer.data import (  # noqa: E402
    BASE_CHARSET, LINE_HEIGHT, LINE_MAX_WIDTH, NUMBER_CHARS, LineDataset, Synthetic, collate, find_fonts, fnv1a, load_export,
)
from ocrtrainer.model import CRNN, greedy_decode  # noqa: E402


def levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def evaluate(model, loader, charset):
    model.eval()
    stats = {"name": [0, 0, 0.0], "number": [0, 0, 0.0]}
    with torch.no_grad():
        for img, _w, _t, _l, texts, fields, _wt in loader:
            logp = model(img)
            for k, (field, truth) in enumerate(zip(fields, texts)):
                pred, _ = greedy_decode(logp[k : k + 1], charset, NUMBER_CHARS if field == "number" else None)[0]
                s = stats[field]
                s[0] += 1
                s[1] += int(pred == truth)
                s[2] += min(1.0, levenshtein(pred, truth) / max(1, len(truth)))
    return {f: {"n": s[0], "accuracy": round(s[1] / s[0], 4) if s[0] else None, "cer": round(s[2] / s[0], 4) if s[0] else None} for f, s in stats.items()}


def usable_datasets(root: str) -> list[str]:
    """Finished exports under <storage>/ocr/datasets, oldest first.

    Only directories holding both files count: stray files (Thumbs.db, notes,
    …) and interrupted exports must never break 'latest'.
    """
    if not os.path.isdir(root):
        return []
    out = []
    for name in os.listdir(root):
        d = os.path.join(root, name)
        if os.path.isdir(d) and os.path.isfile(os.path.join(d, "train.jsonl")) and os.path.isfile(os.path.join(d, "info.json")):
            out.append(name)
    return sorted(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--storage", required=True, help="CardVault storage folder (STORAGE_DIR)")
    ap.add_argument("--dataset", default="latest", help="dataset id under <storage>/ocr/datasets, or 'latest'")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=48)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--synthetic", type=int, default=20000, help="synthetic lines per epoch (0 = none)")
    ap.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--max-minutes", type=float, default=0, help="stop after this long (0 = no limit)")
    args = ap.parse_args()

    # counts keys and card names carry non-ASCII (·, é, ♂ …): never let a
    # non-UTF-8 locale crash the run while printing what was loaded
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    np.random.seed(args.seed)

    root = os.path.join(args.storage, "ocr", "datasets")
    usable = usable_datasets(root)
    requested = args.dataset.strip()
    if requested != "latest":
        ds_id = requested
        d = os.path.join(root, ds_id)
        want = [f for f in ("train.jsonl", "info.json") if not os.path.isfile(os.path.join(d, f))]
        if want:
            hint = f"dataset {ds_id} is incomplete (missing {', '.join(want)})" if os.path.isdir(d) else f"no dataset {ds_id} in {root}"
            listing = ", ".join(usable[-5:]) if usable else "none"
            sys.exit(f"{hint}. Usable datasets: {listing}")
    else:
        ds_id = usable[-1] if usable else None
    if not ds_id:
        sys.exit(f"No usable dataset in {root}. Export one from CardVault: Developer → OCR Lab → Export training data.")
    lines, info = load_export(os.path.join(root, ds_id), args.storage)
    print(f"dataset {ds_id}: {len(lines)} lines {info.get('counts')}")
    if not lines:
        sys.exit("The dataset has no usable lines.")

    # dev = ~6% of training groups (whole cards), never the exam
    dev = [ln for ln in lines if fnv1a(f"dev:{ln.group}") % 100 < 6]
    train = [ln for ln in lines if fnv1a(f"dev:{ln.group}") % 100 >= 6]
    # weight: corrected / reviewed lines are seen more often
    train = [ln for ln in train for _ in range(max(1, round(ln.weight)))]

    names: set[str] = {ln.text for ln in lines if ln.field == "name"}
    cache = os.path.join(args.storage, "cache")
    if os.path.isdir(cache):
        for f in os.listdir(cache):
            if f.startswith("card-names-") and f.endswith(".json"):
                try:
                    with open(os.path.join(cache, f), encoding="utf-8") as fh:
                        names.update(json.load(fh))
                except (OSError, ValueError):
                    pass
    charset = "".join(sorted(set(BASE_CHARSET) | {c for n in names for c in n} | {c for ln in lines for c in ln.text}))
    fonts = find_fonts() if args.synthetic else []
    synthetic = None
    if args.synthetic and fonts:
        synthetic = Synthetic(fonts, sorted(names), [ln.path for ln in lines if ln.path][:2000], seed=args.seed)
        print(f"synthetic: {args.synthetic} lines/epoch, {len(fonts)} fonts, {len(names)} names")
    elif args.synthetic:
        print("synthetic: no fonts found on this machine, training on exported lines only")

    train_ds = LineDataset(train, charset, train=True, synthetic=synthetic, synthetic_count=args.synthetic if synthetic else 0, seed=args.seed)
    dev_ds = LineDataset(dev, charset, train=False)
    train_dl = torch.utils.data.DataLoader(train_ds, batch_size=args.batch, shuffle=True, collate_fn=collate, num_workers=0, drop_last=True)
    dev_dl = torch.utils.data.DataLoader(dev_ds, batch_size=args.batch, shuffle=False, collate_fn=collate)

    model = CRNN(len(charset) + 1)
    params = sum(p.numel() for p in model.parameters())
    print(f"model: CRNN, {params / 1e6:.2f}M parameters, charset {len(charset)}; train {len(train_ds)} / dev {len(dev_ds)} per epoch")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = max(1, len(train_dl) * args.epochs)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps, pct_start=0.15)
    ctc = nn.CTCLoss(blank=0, zero_infinity=True, reduction="none")

    started = time.time()
    best, best_state, history = None, None, []
    for epoch in range(1, args.epochs + 1):
        model.train()
        total, batches = 0.0, 0
        for img, _w, targets, lengths, _texts, _fields, _wt in train_dl:
            logp = model(img)  # [B, T, C]
            T = logp.shape[1]
            loss = ctc(logp.permute(1, 0, 2), targets, torch.full((img.shape[0],), T, dtype=torch.long), lengths)
            loss = (loss / lengths.clamp(min=1)).mean()
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()
            sched.step()
            total += float(loss.detach())
            batches += 1
        m = evaluate(model, dev_dl, charset) if len(dev_ds) else {}
        score = sum((m[f]["accuracy"] or 0) * m[f]["n"] for f in m) / max(1, sum(m[f]["n"] for f in m)) if m else -total
        history.append({"epoch": epoch, "loss": round(total / max(1, batches), 4), "dev": m})
        mins = (time.time() - started) / 60
        print(f"epoch {epoch:3d}  loss {total / max(1, batches):.4f}  dev name {m.get('name', {}).get('accuracy')}  number {m.get('number', {}).get('accuracy')}  ({mins:.1f} min)", flush=True)
        if best is None or score >= best:
            best, best_state = score, {k: v.clone() for k, v in model.state_dict().items()}
        if args.max_minutes and mins >= args.max_minutes:
            print("time limit reached")
            break
    model.load_state_dict(best_state)
    model.eval()

    # ---- export
    stamp = time.strftime("%Y%m%d-%H%M%S")
    model_id = f"crnn-{stamp}"
    out = os.path.join(args.storage, "ocr", "models", model_id)
    os.makedirs(out, exist_ok=True)
    dummy = torch.zeros(1, 1, LINE_HEIGHT, 160)
    onnx_path = os.path.join(out, "model.onnx")
    torch.onnx.export(
        model, dummy, onnx_path, input_names=["image"], output_names=["logp"],
        dynamic_axes={"image": {3: "width"}, "logp": {1: "steps"}}, opset_version=17, dynamo=False,
    )
    # the exported model must agree with the trained one
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(onnx_path)
        x = torch.randn(1, 1, LINE_HEIGHT, 200)
        diff = float(np.abs(sess.run(None, {"image": x.numpy()})[0] - model(x).detach().numpy()).max())
        print(f"onnx check: max difference {diff:.2e}")
        if diff > 1e-3:
            sys.exit("ONNX export does not match the trained model")
    except ImportError:
        print("onnxruntime not installed: skipped the export check")

    final = evaluate(model, dev_dl, charset) if len(dev_ds) else {}
    card = {
        "id": model_id,
        "architecture": "crnn-ctc",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "charset": charset,
        "input": {"height": LINE_HEIGHT, "maxWidth": LINE_MAX_WIDTH, "range": [-1, 1], "layout": "NCHW gray"},
        "output": {"name": "logp", "layout": "[batch, steps, classes]", "blank": 0},
        "dataset": {"id": ds_id, "sha256": info.get("sha256"), "rows": info.get("rows"), "counts": info.get("counts")},
        "training": {"epochs": len(history), "batch": args.batch, "lr": args.lr, "synthetic": args.synthetic if synthetic else 0, "parameters": params, "minutes": round((time.time() - started) / 60, 1), "seed": args.seed},
        "dev": final,
        "history": history,
    }
    with open(os.path.join(out, "card.json"), "w") as f:
        json.dump(card, f, indent=2, ensure_ascii=False)
    print(f"\nwrote {out}\n  dev: {json.dumps(final)}\nIn CardVault: Developer → OCR Lab → Models → Score it on the exam.")


if __name__ == "__main__":
    main()
