# CardVault

A private, self-hosted card collection platform for the family. You scan cards with a webcam or phone, CardVault identifies them, and background workers keep researching prices. Each family member keeps their own collection on a shared "digital card table".

Supported: **Pokémon · Magic: The Gathering · Yu-Gi-Oh! · Football · Baseball · Basketball · Hockey · other cards**

> **Scan once. Research forever.** A scanned card stays in the database. Workers keep adding price observations to it, so its history becomes more useful over time.

---

## Quick start (Docker, home server)

```bash
cp .env.example .env
# fill in POSTGRES_PASSWORD, SESSION_SECRET (openssl rand -base64 48), ADMIN_PASSWORD, WEB_ORIGIN
docker compose up -d --build
docker compose exec api node apps/api/dist/cli/create-user.js --bootstrap   # first admin from ADMIN_* vars
```

Open `http://<server>:8080` and sign in. Add the rest of the family from the user menu → **Users**. There is no public registration.

| Profile | Command | What it adds |
|---|---|---|
| default | `docker compose up -d` | web (nginx), api, worker, postgres, redis |
| `https` | `docker compose --profile https up -d` | Caddy at `https://cardvault.home` |
| `backup` | `docker compose --profile backup up -d` | nightly DB dumps, weekly image archives |

Only the web port is published. PostgreSQL, Redis and the worker stay on the internal Docker network.

### HTTPS (needed for phone cameras)

Browsers allow camera access only on **HTTPS or `localhost`**. Over plain `http://cardvault.local`, phones fall back to **"Upload photo instead"**, which opens the native camera and still works. For the live scanner with auto-capture:

1. Point `cardvault.home` at the server in your router's DNS (or in each device's hosts file).
2. Set `WEB_ORIGIN=https://cardvault.home` and `COOKIE_SECURE=true`, then run `docker compose --profile https up -d`.
3. Install Caddy's local root certificate on each device once: `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`

### Demo data

Set `SEED_DEMO=true` to load 8 sample cards (Pikachu, Charizard, Black Lotus, Blue-Eyes, Tom Brady, …) with 120 days of **synthetic** prices. These rows are tagged `source = demo`.

---

## Development

Requirements: Node 22+, pnpm 10, PostgreSQL 16, Redis 7.

```bash
pnpm install
cp .env.example .env                 # set ADMIN_PASSWORD; dev defaults work for the rest
pnpm build                           # builds the shared packages (apps import their dist/)
pnpm db:migrate && pnpm db:seed --demo
pnpm user:create --bootstrap         # admin from ADMIN_USERNAME / ADMIN_PASSWORD
pnpm user:create sam "Sam"           # prompts for a password

pnpm dev:api      # :3000  Fastify
pnpm dev:worker   # BullMQ workers
pnpm dev:web      # :5173  Vite (proxies /api → :3000)
pnpm test         # unit tests (pricing stats, confidence, SSRF guard, robots, hashing, OCR signal extraction)
```

After changing `packages/database/src/schema.ts`, run `pnpm db:generate` to write a new migration into `migrations/`.

---

## Architecture

```
 Browser (React/Vite)                 API (Fastify)                Worker (BullMQ)
 ───────────────────                  ─────────────                ───────────────
 Scanner ─► IndexedDB queue ─POST /api/scans─► store image ─► identification queue ─► OCR + catalog + image hash
                                       │                        research queue ─────► providers → price_observations
 Library ◄── REST ─────────────────────┤                        pricing           ─► price_snapshots
 Job monitor ◄── SSE /api/events ◄─────┴── Redis pub/sub ◄───── events            maintenance: recovery, refresh, value snapshots
                                       PostgreSQL (Drizzle)     Redis (queues, AOF persistence)
```

The browser only creates jobs and never runs a crawl. If you close the tab, the server keeps working. If you restart the server, Redis (with AOF) keeps the queue, and BullMQ re-runs jobs that stalled.

```
apps/
  web/       React + TypeScript + Vite + Zustand + Recharts
  api/       Fastify REST + SSE, auth, uploads, admin
  worker/    identification, research, pricing, image, maintenance processors; providers
packages/
  shared/        enums, job states, events, pricing statistics, confidence scoring
  card-model/    generic NormalizedCard + per-game modules (attributes, display fields, OCR hints)
  provider-sdk/  CardProvider interface, HTTP client with rate limit/retry/circuit breaker/SSRF guard
  database/      Drizzle schema, migrations runner, seed
  imaging/       sharp normalization, thumbnails, 256-bit dHash, quality metrics
  jobs/          BullMQ queue factory + Redis event bus
  config/        validated environment config
migrations/      SQL migrations (drizzle-kit)
docker/          Dockerfile (api/worker/web targets), nginx, Caddy
scripts/         backup.sh, restore.sh
```

### Scanning and identification

1. **In the browser** (Canvas API, no OpenCV needed). The scanner checks focus (Laplacian variance), lighting and glare. It finds the card's edges by sampling scan-lines around the guide and fitting robust lines, then takes their intersections as corners. Once the card is detected, stable and sharp, it auto-captures. It then corrects perspective and rotation with a homography warp, normalizes exposure, and saves the image to an **IndexedDB queue**. Uploads retry with backoff, and the server ignores repeats of the same `clientScanId`, so scanning keeps working through server outages.
2. **On upload** the API decodes the image to validate it (it doesn't trust the MIME type), re-encodes it (stripping EXIF), makes a thumbnail, and computes a 256-bit perceptual hash. If you already scanned a near-identical image, it answers *"You already scanned this card"* with **Add another copy / View existing / Cancel**.
3. **The worker** combines several signals rather than relying on OCR alone:
   - Tesseract OCR on the whole card plus the title and footer bands. The English model ships with the worker, so no CDN is needed.
   - Game guess from keywords, name candidates, and collector numbers matched with each game's patterns.
   - Variant hints: "1st Edition", serial `/99`, autograph, relic.
   - The **local catalog** first: exact collector number, trigram name similarity, and perceptual-hash similarity against cached catalog images.
   - Catalog APIs only when the local catalog can't decide. Their results are imported, so the next scan of that card is local.
4. Confidence decides what happens next:

   | Confidence | Result |
   |---|---|
   | ≥ 95% | Auto-accepted and added to the collection; research starts |
   | 80–94% | Verification queue with one-click "Confirm" |
   | < 80% | Manual processing |

   Two near-tied candidates (for example reprints) are capped below 95%.
5. **Manual review** stores the original identification next to the human correction, with who made it and when. A card that isn't in any catalog (common for sports cards) becomes a new catalog entry.

### Providers

Each source implements `CardProvider` (`search / getCard / getPrices / getSales / getImages`) and returns normalized data. Every provider gets its own rate limiter, bounded retries with exponential backoff (honouring `Retry-After`), timeout, circuit breaker, fixed User-Agent and request logging. Admins can enable or disable providers at runtime.

| Provider | Games | Provides | Notes |
|---|---|---|---|
| TCGdex | Pokémon | identity, images | free, no key |
| Pokémon TCG API | Pokémon | identity, TCGplayer market prices | deprecated, keys end 2027-03-01, so it isn't a hard dependency |
| Scryfall | Magic | identity, images, USD/foil/etched prices | 8 req/s |
| YGOPRODeck | Yu-Gi-Oh! | identity, images, set prices | images are cached locally, per their guidelines |
| eBay Browse API | all | active listings (Buy It Now / auction) | needs `EBAY_CLIENT_ID/SECRET`. Sold data needs eBay's restricted Marketplace Insights API; add `getSales()` if you're granted access |
| Web crawler template | — | — | `apps/worker/src/crawlers/web-crawler.ts`: checks robots.txt, uses a host allowlist, never bypasses CAPTCHAs or logins. Disabled by default |

TCGplayer's API is closed to new developers, so nothing depends on it.

### Pricing

The database stores **individual observations** (`price_observations`) rather than a single "current price", and never mixes **listed** and **sold** prices. Snapshots hold:

- market price, preferring the recent sold median
- sold and listed median and average
- min and max
- 30-day, 90-day and 1-year averages
- 30-day trend and volatility

Outliers are removed with an IQR rule, so one abnormal sale doesn't distort the average. A daily per-user collection-value snapshot powers the "today / 7 / 30 / 90 days" figures. **Back up price history.** Unlike the card catalog, it can't be re-downloaded.

### Security

- Argon2id password hashes.
- Opaque session tokens stored hashed in Postgres, sent as an HTTP-only `SameSite=Strict` cookie (`Secure` behind HTTPS).
- CSRF token header plus an Origin check on every state-changing request.
- Account lockout after 5 failed logins; rate limits on all routes, stricter on login.
- zod validation on every input; Drizzle with parameterized SQL only.
- Uploads: size limit, decode-based type validation, pixel cap, re-encoding.
- Stored files are served only through an authenticated, traversal-safe route.
- **SSRF protection** in the crawler HTTP client: https only, per-provider host allowlist, DNS resolution with every address checked (localhost, RFC 1918, link-local / `169.254.169.254` metadata, CGNAT, ULA and `.local/.home/.internal` are blocked), and the connection is pinned to the checked IP (prevents DNS rebinding). Each redirect hop is re-checked. Users can never submit URLs to fetch.
- Audit log of logins, user changes, collection edits, reviews, job and provider actions.

### Real-time events

`JOB_CREATED, JOB_STARTED, JOB_PROGRESS, IDENTIFICATION_COMPLETE, IDENTIFICATION_FAILED, RESEARCH_STARTED, CARD_RESEARCH_COMPLETE, PRICE_UPDATED, JOB_COMPLETE, JOB_FAILED, MANUAL_REVIEW_REQUIRED, WORKER_HEARTBEAT`. These go over Server-Sent Events at `/api/events`, filtered to each user.

### Job recovery

Workers send a heartbeat every 15 s, shown in the user menu → **Providers · Workers · System**. BullMQ moves a stalled job (worker crashed mid-job) back to waiting. Every 5 minutes, a maintenance sweep re-queues jobs whose database row is stuck in an active state with no queue entry (for example after Redis was reset): `PROCESSING → QUEUED`. Cancelling a running job takes effect at its next stage checkpoint.

---

## Backups

```bash
docker compose --profile backup up -d                  # nightly pg_dump (keeps 14), Sunday image tarball (keeps 8)
docker compose run --rm -e FORCE_IMAGES=1 backup bash /backup.sh   # run a backup now
scripts/restore.sh backups/db/cardvault-….dump [backups/images/storage-….tar.gz]
```

Copy `./backups` to another disk or machine as well.

---

## Status against the roadmap

| Phase | State |
|---|---|
| 1 Foundation: auth, users, sessions, dashboard, Docker | ✅ |
| 2 Card model: games, sets, cards, variants, collection items, game extensions | ✅ |
| 3 Scanner: webcam, detection, perspective correction, quality checks, auto-capture, offline queue | ✅ |
| 4 Identifier: OCR, catalog, name/set/number matching, confidence | ✅ (all games, not just Pokémon) |
| 5 Queue: BullMQ, persistence, retry, recovery, monitoring | ✅ |
| 6 Research engine: provider SDK; Pokémon, Magic, Yu-Gi-Oh, eBay | ✅ |
| 7 Pricing: observations, sold vs listed, statistics, history charts | ✅ |
| 8 Manual review: corrections stored, approve/reject, research after | ✅ |
| 9 3D collection: tilt cards, themes, detail dialog | ✅ |
| 10 Game modules: Pokémon / Magic / Yu-Gi-Oh / 4 sports | ✅ attributes and display; sports have no free catalog API |
| 11 Analytics: value history, by game/set/user, set completion, duplicates | ✅ (duplicates via `/api/collection/duplicates`; no dedicated page yet) |
| 12 Hardening: backups, audit, provider monitoring, worker recovery | ✅ basics; no performance testing yet |

### Known limitations and next steps

- **Holo vs non-holo** isn't detected from the image. The variant comes from printed text ("1st Edition", serial numbers) or the card's default, and you can change it under "My copy".
- **Image matching** uses a perceptual hash against cached catalog images. The planned upgrade is CLIP-style embeddings in **pgvector**, which fits the existing schema (`cards.image_hash` → an embedding column).
- **Upside-down captures** aren't auto-rotated by 180°.
- **eBay sold prices** need Marketplace Insights API access. Without it, eBay adds listed prices only, and sold-style figures come from the TCGplayer, Scryfall and YGOPRODeck aggregates.
- **Themes** use CSS gradients only and ship no third-party artwork. To use your own images, set `backgroundImage` in `apps/web/src/themes/index.ts` and put the files in `apps/web/public/themes/`.
- Future-features list (trading, want lists, binders, deck builders, alerts): not started.
