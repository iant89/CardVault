# TCGdex Harvester

A local web app that downloads every Pokémon card image and its data from the
free [TCGdex](https://tcgdex.dev) API into an organized folder, at a pace
that keeps you well within what the volunteer-run service can handle. It's
used to build an OCR training set for CardVault.

No dependencies: Node 20.10+ only.

```bash
node tools/tcgdex-harvester/src/server.mjs
# → open http://127.0.0.1:4777
```

1. **Discover** lists every series and set (a few dozen requests).
2. Pick sets (all are selected by default). The header estimates requests,
   time and disk space.
3. **Start**. Close the browser if you like: downloads continue in the
   background, and the page picks up the live feed again when reopened.

## From CardVault

Administrators get a **Developer** menu in CardVault's nav bar. *Start &
open* launches the harvester on the server (if it isn't already running) and
opens its dashboard in a new tab. The menu shows live progress and can stop
it. The dashboard is served through CardVault's own address
(`/api/dev/harvester/app/`), so it works from any device that can open
CardVault. The harvester itself still listens on `127.0.0.1` only, and every
request passes CardVault's login, admin check and CSRF check first.

Settings (`.env`): `DEV_TOOLS=false` hides the menu; `HARVESTER_PORT`
(default 4777); `HARVESTER_OUT_DIR` (default `$STORAGE_DIR/tcgdex-data`).
Its log is `.harvester/server.log` in that folder.

## Features

| | |
|---|---|
| **Rate limiting** | A token bucket per host (default 2 req/s, adjustable live from 0.2 to 10). On `429`/`503` the rate halves, the host is blocked for `Retry-After` (capped at 2 min), and the rate recovers gradually after a run of successes. |
| **Retries** | Network errors and 5xx retry with exponential backoff and jitter (up to 5 attempts). A missing image (404) is marked *skipped*, not failed. |
| **Circuit breaker** | 10 failures in a row auto-pause the run with an explanation, instead of hammering a server that's down. |
| **Pause / resume** | Pausing stops in-flight downloads at once and puts them back at the front of the queue. Space toggles it. |
| **Survives restarts** | The queue is saved to `.harvester/state.json`. Stopping the server (Ctrl+C) mid-run resumes automatically on the next start, and files already on disk are never fetched again. |
| **Interactive queue** | Filter by status and type, search, *do next*, skip or retry single items, *retry all failed*, and move a whole set to the front. |
| **Live dashboard** | Progress ring with a projected total, speed, bandwidth, ETA, a throughput chart, each host's effective rate and cool-down, per-set progress bars, a live log, and a gallery of cards as they arrive. |

Settings: image quality (`high` 600×825 / `low` 245×337), format (PNG, WebP,
JPG), what to download (images, card JSON, set logos and symbols) and
language. They apply to items queued from then on.

## Output

```
tcgdex-data/
  en/
    series.json                  every series
    sets.json                    every set
    cards.json                   flat index: id, name, set, localId, data + image paths
    index.json                   summary per set: counts, failures, bytes, folder
    sets/<serie>/<set>/
      set.json                   the set with its card list
      logo.png  symbol.png
      cards/<localId>.json       full card data
      images/high/<localId>.png  card image
  .harvester/state.json          the queue (resume point)
```

Images are checked by their bytes: an HTML error page is never saved as a
`.png`. Every write is atomic, so a crash never leaves half a file. The
index files are rewritten whenever a run finishes.

## Options

```
--port 4777            PORT
--host 127.0.0.1       HOST          (localhost only by default)
--out  ./tcgdex-data   OUT_DIR
--api  https://api.tcgdex.net/v2     TCGDEX_API
```

The server only answers requests addressed to localhost, and refuses
cross-site `POST`s, so another website open in your browser can't drive it.

## Testing and demo

```bash
npm test --prefix tools/tcgdex-harvester     # 10 tests, about 1 minute
npm run demo --prefix tools/tcgdex-harvester # the dashboard against a local mock
```

`test/mock-tcgdex.mjs` mimics the TCGdex API and asset host (same URLs and
JSON shapes), generates card images, and enforces a strict rate limit with
`429` + `Retry-After`. The tests check that downloads stay within that
limit, that the tool backs off when pushed and still finishes, and that
pause, restart and resume never download a file twice.

## Be a good citizen

TCGdex is free and run by volunteers. Keep the rate modest; the default of
2 requests per second takes about 6 hours for the full English catalog
(about 20,000 cards: one request for each image and one for each card's data). The card data is MIT-licensed;
the card **artwork** belongs to The Pokémon Company and its artists. Keep
the downloaded images for your own use (here, training CardVault's OCR) and
don't commit or republish them. `tcgdex-data/` is git-ignored for that
reason.
