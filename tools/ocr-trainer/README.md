# OCR trainer

Trains CardVault's own **line reader**: a small CRNN + CTC model (~2M
parameters, CPU is enough) that reads the two lines CardVault cares about on a
card, the **title** and the **collector number**. CardVault already knows where
these sit on each game's cards, so the model only has to read one short line
at a time.

A trained model never goes live by itself. CardVault scores it on the frozen
exam and only lets you promote it when it beats the current engine without
getting worse anywhere (see *Promotion gates*).

## The loop

1. **Collect.** Every scan stores its title and number crops. Cards confirmed or
   corrected in Manual Review, auto-identifications backed by independent
   evidence, and imported TCGdex harvest cards become labelled lines
   (Developer → OCR Lab).
2. **Export** (OCR Lab → Models → *Export training data*). Writes
   `storage/ocr/datasets/<id>/train.jsonl` + `info.json`:
   - training-side lines only: the exam is **never** exported
   - never labels the engine only confirmed itself (`self`)
   - lines a person corrected count triple, reviewed lines double
   - for harvested cards, which number spot holds the number is decided per set
     by a small vote, and the label comes from TCGdex, never from what was read
3. **Train** — right in the app: OCR Lab → Models → *Train*, which runs the
   trainer on the server and shows its progress (dataset, epochs, held-out
   accuracy), or on the server by hand:

   ```bash
   bash scripts/ocr-python.sh          # the Python the trainer needs (once)
   storage/ocr/venv/bin/python tools/ocr-trainer/train.py --storage /path/to/storage
   ```

   `scripts/ocr-python.sh` builds a virtual environment in
   `storage/ocr/venv` with the CPU build of PyTorch and everything in
   `requirements.txt`. The native installer runs it, and OCR Lab offers the
   same as **Set up the OCR trainer** — the worker does the download, so no
   shell is needed. It only needs python3 (3.9+) and internet access to PyPI /
   pytorch.org; the CPU wheels are a few hundred MB. Without the venv, training
   falls back to `~/ocr-venv`, then `python3`/`python` on PATH.

   Options: `--dataset <id>` (default: latest), `--epochs 30`,
   `--synthetic 20000` (generated lines per epoch), `--max-minutes 60`,
   `--threads N`. The model, its ONNX export and a model card land in
   `storage/ocr/models/<model id>/`. The *Train* button registers the finished
   model for scoring by itself.
4. **Score** (OCR Lab → Models → *Look for new models*, then *Score on exam*).
5. **Live trial** (*Start live trial*): the model reads every new scan
   alongside the live engine. Its readings are only recorded; identification
   never uses them. As scans are confirmed, both readings are compared.
6. **Promote** when every gate passes, the trial included. Live scans switch
   within 30 seconds.
7. **Live watch**: every 15 minutes the active model's live accuracy on
   confirmed lines, and the share of scans needing manual review, are compared
   with the previous engine's over the same length of time before the switch.
   If either is clearly worse, CardVault switches back to the previous engine
   by itself and records why (OCR Lab → Models → History). *Roll back* does the
   same by hand.

## What the model sees

`ocrtrainer/data.py::to_tensor` must match CardVault's `lineTensor()`
(`packages/imaging/src/index.ts`): grayscale, 32 px tall, width scaled to keep
the aspect ratio (8 to 512 px), values in [-1, 1]. Decoding (`greedy_decode`)
matches `engines.ts`: number spots may only produce collector-number characters.

Training lines are augmented to look like phone captures: imperfect framing,
slight rotation, low resolution, blur, lighting, JPEG and sensor noise.
Synthetic lines (card names from CardVault's name lists, and collector-number
formats like `086/193`, `TG05/TG30`, `SWSH123`) are rendered with the machine's
fonts onto patches of real crops. With no fonts installed, training uses the
exported lines only.

## Promotion gates

On the **same exam version** as the current engine, a candidate must:

| Gate | Rule |
|---|---|
| Overall | names and numbers each at least as accurate (0.5 point tolerance) |
| No slice worse | no game / era / label-source slice with 20+ items loses more than 2 points |
| Fixed stays fixed | at least as many human-corrected misreads (regression set) read right |
| Speed | at most 1.5× slower per line (or under 50 ms) |
| Honest confidence | when ≥90% sure (20+ such reads), right at least 95% of the time |
| Live trial | on real scans confirmed since the trial started (40+ lines): at least as accurate as the live engine, and no more lines lost than won |

The server re-checks the gates when *Promote* is pressed. While a model is
active, any line it reads with under 50% confidence is read by Tesseract
instead.

## After promotion: the live watch

| Rule | Default |
|---|---|
| Judge only with enough data on both sides | 30 confirmed lines, 20 scans |
| Roll back if live line accuracy drops by more than | 5 points |
| Roll back if scans needing manual review rise by more than | 15 points |

Settings in `.env`: `OCR_TRIAL_MIN_LINES`, `OCR_WATCH_MIN_LINES`,
`OCR_WATCH_MIN_SCANS`, `OCR_WATCH_MAX_DROP`, `OCR_WATCH_MAX_REVIEW_RISE`.

The watch matters because the per-line safety net can't catch everything: a
broken model can be confidently wrong. In testing, a deliberately undertrained
model returned empty readings at about 65% confidence, above the 50% fallback
threshold. The watch rolled it back on the rise in manual reviews.

## Files

```
train.py                      CLI: load export, train, pick best epoch on a dev slice, export ONNX + card
ocrtrainer/data.py            preprocessing, augmentation, synthetic lines, dataset
ocrtrainer/model.py           CRNN and CTC greedy decoding
../../scripts/ocr-python.sh   builds the Python above (venv, CPU PyTorch, requirements)
```

`card.json` records the dataset id and checksum, training settings, the dev
result and the per-epoch history, so every model can be traced to its data.
