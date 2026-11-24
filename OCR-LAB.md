# OCR Lab — what changed

The lab is now a workbench for the line reader rather than a single scroll: a header with live
status and a task queue, a KPI strip, and four tabs.

## The task queue (upper right)

Every long action goes through **one queue**:

| Action | Task it creates |
|---|---|
| Score an engine / a model on the exam | `Score <engine> on exam v<n>` |
| Export training data | `Export training data` |
| Train a line reader | `Train a line reader` |
| Train with CardVault-Vision | `Train with CardVault-Vision` |
| Set up the trainer's Python | `Set up the trainer's Python` (3 phases) |
| Import harvested TCGdex cards | `Import harvested cards` |
| Refresh trials / live watch | `Refresh trials & live watch` |
| Look for new models | `Look for new models` |

- **The button** carries a progress **ring** with the active task's percentage. With nothing
  running it shows an idle track; if something failed it gets a small red badge and says so.
- **The popup** lists running tasks first, then queued, then finished. Each entry shows:
  - task name and kind (Scoring / Export / Training / Setup / Import …),
  - a one-line description of what it is doing *right now* (epoch, loss, step, "waiting for the worker"),
  - state (Queued / Running / Done / Failed / Cancelled),
  - a progress bar plus the underlying counts (`420 / 1,000 groups`),
  - runtime — live, ticking every second while open — and, while running, the **time until finished**,
  - a stop button while running; repeat or remove once finished. `Clear finished` tidies the list.
- Cancelling a score stops it between groups and it is reported as **cancelled**, never as done.

## Training

The trainer (`tools/ocr-trainer/train.py`) now reports a run plan, per-step loss, seconds per
epoch, and the held-out lines it re-reads after every epoch, including their crop paths. The
worker turns that into progress the queue can show, and the Training tab shows:

- **Elapsed** and **time until finished** — from the pace so far, shown as "estimating after the
  first epoch…" before there is a pace to measure rather than inventing a number.
- Epoch / step counters, current loss, average time per epoch, the best checkpoint so far.
- **Held-out accuracy per epoch** — a hand-drawn SVG curve for names and numbers, with the best
  epoch marked.
- **Recent held-out lines** — the crops the model did *not* train on, each with what it read,
  **whether that was right**, what the line really says, and **how sure it was** (a confidence bar
  and a percentage). A line it reads correctly and confidently is learning; one it is confidently
  wrong about is the clearest sign more data or more epochs are needed.

Setting "Stop after minutes" in the form now keeps the best epoch and writes that model (a
deliberate cut-off), instead of throwing the run away when it hits the wall-clock limit.

## CardVault-Vision runs

The Training tab has a second form, **Train with CardVault-Vision**, for the
[model factory](https://github.com/iant89/CardVault-Vision). One run trains one or more of its
three heads from the same dataset export:

| Heads | What is trained | What lands in Models |
|---|---|---|
| `name-ocr` + `number-ocr` | two recognisers, one per box | one `vision-ocr-*` row with both heads |
| `name-ocr` or `number-ocr` | a single recogniser | a row with that head only (useful while one box's data is thin) |
| `card-classifier` | the whole-card game/layout classifier | a `vision-classifier-*` row |
| all three | all of the above, one after another | both rows, sharing the run's version |

Compared with the built-in trainer, the run form and the live panel differ in what they show,
because a Vision run is *stages*, not one loss curve:

- **One chip per head**, with its state — training (`•`), exporting (`↑`), done (`✓`, with its
  best held-out metric), failed (`✕`, with the error) — so "name done, number still training" is
  visible at a glance. The ring and the bar follow stages finished, not epochs inside one head.
- **Per-head metrics**: held-out **CER** for a recogniser (lower is better) and **macro F1** for
  the classifier, both from the factory's own `--json` lines rather than re-derived here.
- **The log is one click away**, on the run and on a failure, because a factory run can fail in
  Python in ways a loss curve cannot explain (no torch, no ONNX export, a bad manifest).
- **Stop** asks the process to finish and export after the current step, then kills it; heads
  that already exported stay registered.

The form only lists exports that wrote a **whole-card manifest** (`<dataset>/vision/manifest.json`),
because the factory trains on cards, not lines — older exports have none, and the form says so
instead of failing later. The manifest records each crop's pixel box and its normalised rect, so
the factory can rebuild the same crops CardVault will feed the exported model. Two details of it
are easy to get wrong and cost a whole run:

- Its `root` is **absolute**. The factory resolves a relative root against the process's working
  directory, not against the manifest, so `"."` would have it looking for the card images next to
  wherever the worker happened to start.
- **20% of cards are held out as `val`** (whole cards, picked by a stable hash of the card id).
  CardVault's own export is all `train`, and with no `val` the factory would report training CER
  as if it were held-out CER. The frozen exam is still the real judge.

A finished run does **not** promote anything. Each export is registered as a *candidate* and the
pipeline is the usual one: score on the frozen exam, pass the gates, live trial (line readers
only), promote. The classifier is scored on the same exam, must beat the active classifier by 0.5
points of game accuracy, and has no trial; it is rolled back on its own (`Stop the classifier`)
without touching the line reader.

## Tabs

- **Overview** — label sources (person-confirmed, corroborated, harvest, self), the frozen exam
  and its version, the TCGdex import, all scores on the exam with slices and misreads, live watch.
- **Models** — export → train → score → trial → promote as a pipeline, each model's gates, its
  trial and the automatic watch that rolls a bad model back.
- **Training** — the live view above, the trainer's Python, a new run form, and the
  CardVault-Vision form and run panel.
- **Collected data** — every collected line with its crop and filters, plus dataset exports.

## Under the hood

- `packages/shared/src/tasks.ts` — the task shape, progress maths and the ETA helpers (shared by
  the API and the UI, so they cannot disagree).
- `packages/jobs/src/tasks.ts` — the queue's memory in redis (created/updated by the worker).
- `GET /api/dev/ocr/queue` folds the worker's records together with the stores that predate the
  queue (the training status, the Python setup, the harvest import, evaluation rows), so nothing
  is invisible while it runs — even after a worker restart.
- `POST /api/dev/ocr/queue/:id/cancel`, `POST …/retry`, `DELETE /api/dev/ocr/queue/:id`,
  `POST /api/dev/ocr/queue/clear`.
