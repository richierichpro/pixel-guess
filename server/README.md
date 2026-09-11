# Gallery backend

Persistent painting gallery + leaderboard for the single-player mode. Deno Deploy + Deno KV, one file, no dependencies.

## Run locally

```sh
cd server
deno task dev        # http://localhost:8787  (Deno picks the port; check the log)
```

Deno KV is created automatically as a local SQLite file.

## Deploy (Deno Deploy)

```sh
deno install -A jsr:@deno/deployctl --global   # once
cd server
deployctl deploy --project=<your-project> --prod main.ts
```

Set an `ADMIN_KEY` env var in the Deno Deploy dashboard (used by `DELETE /painting/:id?key=...`).
KV is provisioned automatically on Deno Deploy — nothing to configure.

## API

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/gallery` | — | `{ atlasUrl, tiles: [{ id, word }] }` — the 12 newest |
| GET | `/atlas.png?v=<ver>` | — | `image/png`, a 576×432 (4×3) grid — each painting baked at 128×128 with an 8px edge-repeated border to stop mip-blur bleeding between tiles |
| POST | `/painting` | `{ word, cells:[256 ints 0..11], author? }` | `{ ok, id }` |
| POST | `/score` | `{ name, userId, correct, total }` | `{ ok }` — one row per `userId`, keeps their best |
| GET | `/leaderboard` | — | `[{ name, correct, userId }]` top 25, sorted |
| DELETE | `/score` | `?key=<ADMIN_KEY>` | wipes the whole leaderboard |
| DELETE | `/painting/:id` | `?key=<ADMIN_KEY>` | hides it, rebuilds the atlas |
| GET | `/painting/:id.png` | — | that one painting as a 192×192 PNG |
| GET | `/painting/:id/restore` | `?key=<ADMIN_KEY>` | un-hides a hidden painting |
| GET | `/admin` | — | admin web page (paste key in it) — thumbnails, LIVE/HIDDEN tags, delete/restore |
| GET | `/admin/list` | `?key=<ADMIN_KEY>` | all paintings: `{ id, word, author, ts, hidden, live }` |

## Managing paintings

Open **`https://<host>/admin`** in a browser, paste the `ADMIN_KEY`, hit load. You get a
thumbnail grid of every painting with its word/author/date, a **LIVE** tag on the 12
currently showing in-world, and **delete** / **restore** buttons. Deleted paintings are
hidden (not erased) and the atlas rebuilds immediately. To *add* paintings, use DRAW mode
in the scene.

`cells` layout and palette indices must match `PALETTE` in `src/game/state.ts` (index 0 = blank).

## Test

```sh
BASE=http://localhost:8787
# submit a painting (all blank except a red diagonal)
curl -s $BASE/painting -X POST -H 'content-type: application/json' \
  -d "{\"word\":\"line\",\"cells\":$(python3 -c 'print([3 if i%17==0 else 0 for i in range(256)])'),\"author\":\"me\"}"
curl -s $BASE/gallery
curl -s "$BASE/atlas.png?v=1" -o atlas.png && open atlas.png
```

## Scene wiring (next step, not done yet)

- `scene.json` needs `"requiredPermissions": ["USE_FETCH", ...]`.
- On load: `GET /gallery` → set the atlas URL as the texture on 12 canvas planes, each sampling its tile via UVs.
- Draw mode: existing 16×16 canvas + word field → `POST /painting`.
- Guess mode: proximity to a canvas → guess box → score; on timeout `POST /score`, show `/leaderboard`.
