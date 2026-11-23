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

## Tabs

- **Overview** — label sources (person-confirmed, corroborated, harvest, self), the frozen exam
  and its version, the TCGdex import, all scores on the exam with slices and misreads, live watch.
- **Models** — export → train → score → trial → promote as a pipeline, each model's gates, its
  trial and the automatic watch that rolls a bad model back.
- **Training** — the live view above, the trainer's Python, and a new run form.
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
