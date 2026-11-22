# CardVault

A private, self-hosted card collection platform for the family. You scan cards with a webcam or phone, CardVault identifies them, and background workers keep researching prices. Each family member keeps their own collection on a shared "digital card table".

Supported: **Pokémon · Magic: The Gathering · Yu-Gi-Oh! · Football · Baseball · Basketball · Hockey · other cards**

> **Scan once. Research forever.** A scanned card stays in the database. Workers keep adding price observations to it, so its history becomes more useful over time.

---

## Quick start (Docker, home server)

```bash
cp .env.example .env
# fill in POSTGRES_PASSWORD, SESSION_SECRET (openssl rand -base64 48), ADMIN_PASSWORD
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

**"Cross-origin request rejected" on the sign-in screen?** The API only accepts sign-ins and changes from pages served by CardVault itself. It compares the page's address (`Origin`) with the address the browser used (`Host`), port included. The bundled nginx forwards the full host, so any address you use works: IP, hostname, `:8080`. If you put another proxy in front that rewrites the `Host` header, list the address(es) you use in `WEB_ORIGIN` (comma-separated) and restart. The error message names the address it saw.

### HTTPS (needed for phone cameras)

Browsers allow camera access only on **HTTPS or `localhost`**. Over plain `http://cardvault.local`, phones fall back to **"Upload photo instead"**, which opens the native camera and still works. For the live scanner with auto-capture:

1. Point `cardvault.home` at the server in your router's DNS (or in each device's hosts file).
2. Set `WEB_ORIGIN=https://cardvault.home` and `COOKIE_SECURE=true`, then run `docker compose --profile https up -d`.
3. Install Caddy's local root certificate on each device once: `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`

### Demo data

Set `SEED_DEMO=true` to load 8 sample cards (Pikachu, Charizard, Black Lotus, Blue-Eyes, Tom Brady, …) with 120 days of **synthetic** prices. These rows are tagged `source = demo`.

---

## Native install (without Docker)

`scripts/install.sh` sets up CardVault directly on a Linux host (Debian/Ubuntu, Fedora/RHEL or Arch). It installs Node.js 22, pnpm, PostgreSQL, Redis and nginx, clones the repository to `/opt/cardvault`, creates the database and admin account, writes systemd units, and serves the UI on port 8080.

```bash
git clone https://github.com/iant89/CardVault.git
cd CardVault
bash scripts/install.sh
```

The script asks for the admin password, whether to start services on boot, whether to allow LAN devices, and whether to set up HTTPS with a local CA (needed for the live phone camera). It detects an existing installation on later runs, offers an upgrade when the tracked branch has new commits, and otherwise opens a menu for:

- service status / start / stop / restart / live logs
- export, import or clear the database
- export or import stored card images
- change a user password, create a user, edit `.env`
- view the PC's hostname and LAN IPs, refresh them, and enable/disable LAN firewall rules at boot
- enable/disable HTTPS with Caddy, publish the root CA at `http://<hostname>/cardvault-ca.crt` over LAN HTTP, and print the phone install instructions

Reopen the console at any time with:

```bash
sudo cardvault-setup
```

If CardVault is already installed, the script goes straight to the menu. If it isn't, it simply asks whether you want to install it. Use menu option 14 to check for upgrades.

nginx listens on all interfaces and is configured with the PC's hostname and private LAN IP addresses, so other devices can open `http://<hostname>:8080` or `http://<lan-ip>:8080`. Both addresses work for sign-in, because nginx passes the full address (port included) to the API's same-origin check.

**Upgrading from an install that showed "Cross-origin request rejected":** earlier versions of the generated nginx config dropped the port, so only the one address in `WEB_ORIGIN` could sign in. To apply the fix:
1. Run `sudo cardvault-setup` and upgrade (option 14). This fetches the new code and console.
2. Run `sudo cardvault-setup` **again** and choose **16 → 1** (refresh addresses, firewall and nginx). This rewrites nginx from the fixed template.

Step 2 is needed once because, during the upgrade, the previous console regenerates nginx before replacing itself. A `cardvault-lan.service` unit refreshes those names and the firewall rules at boot (when LAN access was accepted during install). Use menu option 16 to change this later, option 17 for network diagnostics (listening port, services, firewall rules), and option 18 to enable/disable HTTPS. Both `ufw` and `firewalld` are supported.

Defaults can be overridden with `CARDVAULT_REPO`, `CARDVAULT_BRANCH`, `CARDVAULT_DIR`, `CARDVAULT_PORT` and `CARDVAULT_USER`. The installer pins the overall progress bar to the bottom row of the terminal, with steps and tasks scrolling above it, and shows a per-task bar for long commands. Full command output is written to `/tmp/cardvault-setup.log`, and `CARDVAULT_VERBOSE=1` streams it live instead. Backups written by the menu land in `/opt/cardvault/backups`.

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

1. **In the browser** (Canvas API, no OpenCV needed). The scanner checks focus (Laplacian variance), lighting and glare. It finds the card's edges by sampling scan-lines around the guide and fitting robust lines, then takes their intersections as corners. Once the card is detected, stable and sharp, it auto-captures. It then corrects perspective and rotation with a homography warp, normalizes exposure, and saves the image to an **IndexedDB queue**. Two modes, toggled on the viewer:
   - **Single** closes the camera after the capture and shows that card's progress, with **Scan another card**.
   - **Batch** keeps the camera open: "✓ Captured", then after 2 s "Ready for the next card…".

   Auto-capture re-arms when the frame has been empty for 0.7 s, or when a clearly different card has been steady for about 1 s (a quick swap). A hand passing over the card doesn't re-trigger it.

   **Alignment check:** each capture is also cropped with an 8% margin, and the card's real edges are found again inside that crop. If a corner is off by more than 2% of the card width, the capture is misaligned. That typically happens when the shutter is pressed while the card is still moving, or before the outline has locked on. Then:
   - The scanner straightens the card using the refined edges and shows the **corrected** and **original** crops side by side, with one choice: **Keep corrected**, **Keep original** or **Retake**.
   - If the card's edges can't be found to correct it, only the original is shown, with **Keep original** or **Retake**.

   Well-aligned captures (about 1% deviation in testing) skip the check, and auto-capture pauses while a question is open. The decision and measured deviation are stored with the scan (`quality.adjusted`, `quality.alignment`).

   A collapsible sidebar lists recent scans, newest first, with running session totals. Hovering (or tapping on a phone) shows each scan's live state and parsed details, with an **Edit** button. Each entry also has:
   - **Retake** (camera icon): after confirmation, the next capture replaces that scan's photo. The old photo is kept until the new one uploads. An unidentified scan keeps its place in the queue and is identified from the new photo. An identified scan loses that identification and the collection copy it created, and is queued again.
   - **Delete** (trash icon): after confirmation, removes the scan, its photos, its pending jobs and the collection copy it created.

   Each scan has an image version number. An identification run still working on a replaced or deleted photo discards its result. Uploads retry with backoff, and the server ignores repeats of the same `clientScanId`, so scanning keeps working through server outages.
2. **On upload** the API decodes the image to validate it (it doesn't trust the MIME type), re-encodes it (stripping EXIF), makes a thumbnail, and computes a 256-bit perceptual hash (used for visual matching).

   **Scanning a card you already own adds another copy automatically.** Prices, sold/listed observations, history and trends belong to the catalog card and its variant, so every copy shares them:
   - The new copy takes the variant of your existing copies (unless the card itself prints a different one, such as "1st Edition"), so it joins the same pricing line.
   - If the card was researched within `RESEARCH_REFRESH_HOURS`, no new research runs. The copy is "Done" immediately with the shared price.
   - The toast says "Added another Pikachu — you now have 3 copies" with **Undo**, in case it was an accidental double capture.
   - Condition, grading, purchase price and notes stay per copy.
3. **The worker** combines several signals rather than relying on OCR alone:
   - Tesseract OCR on the whole card plus the title and footer bands. The English model ships with the worker, so no CDN is needed.
   - Game guess from keywords, name candidates, and collector numbers matched with each game's patterns.
   - Variant hints: "1st Edition", serial `/99`, autograph, relic.
   - The **local catalog** first: exact collector number, trigram name similarity, and perceptual-hash similarity against cached catalog images.
   - Catalog APIs only when the local catalog can't decide. Their results are imported, so the next scan of that card is local.
4. Confidence decides what happens next:

   | Confidence | Result |
   |---|---|
   | ≥ 95% | Auto-accepted and added to the collection; research starts (skipped while the card's shared prices are fresh) |
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
