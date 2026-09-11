/**
 * Persistent painting gallery + leaderboard for the DCL scene (single-player mode).
 *
 * Deno Deploy, single file, zero external imports. Uses Deno KV.
 *
 *   deno task dev        # local, http://localhost:8787
 *   deployctl deploy --project=<name> --prod server/main.ts
 *
 * Endpoints
 *   GET  /gallery                -> { atlasUrls: string[3], tiles: [{ id, word, cells }] }  (12 newest)
 *   GET  /atlas.png?v=<ver>&g=<0-2>  -> image/png  (one row of 4 tiles, 144px tall, per group)
 *   POST /painting           -> { word, cells:[256 ints 0..11], author? }  -> { ok, id }
 *   POST /score              -> { name, correct, total }                    -> { ok }
 *   GET  /leaderboard        -> [{ name, correct }]  (top 10, best per name)
 *   DELETE /painting/:id?key=<ADMIN_KEY>  -> hides a painting, rebuilds atlas
 */

// KV_PATH set → self-hosted (Railway volume). Unset → Deno Deploy managed KV.
const kv = await Deno.openKv(Deno.env.get("KV_PATH") || undefined)
const ADMIN_KEY = Deno.env.get("ADMIN_KEY") ?? "changeme"
const PORT = Number(Deno.env.get("PORT")) || 8000

const GRID = 16
const CELLS = GRID * GRID
const MAX_TILES = 12

// The 12 paintings are split across GROUPS separate atlas IMAGES of
// GROUP_SIZE tiles each (a single row per image), not one shared 4x3 grid or
// one 12-wide strip. History:
//  - 4x3 grid (576x432, one image): a tile's row is selected via a V-axis
//    flip ("atlas row 0 is the top of the image, but uv v=0 is the bottom").
//    That flip's direction is a renderer convention — desktop and mobile
//    disagreed on it (confirmed: a row-0 painting rendered as the row-2
//    painting on MOBILE only, an exact symmetric swap under 3 rows).
//  - Single row of 12 (1728x144, one image): removes row-selection entirely
//    (fixed mobile) but the extreme 12:1 aspect ratio broke DESKTOP instead —
//    same image file, only desktop rendered it as corrupted vertical stripes
//    (a mip/LOD artifact tied to the very elongated width).
//  - GROUP_SIZE-per-image (this version): each image is still a single row
//    (no row-selection math, so no mobile V-flip bug) AND each image's width
//    matches the ORIGINAL 576px dimension that was always safe on desktop
//    (so no extreme-aspect-ratio bug either). Costs GROUPS separate fetches
//    instead of 1 — an acceptable trade for correctness on both platforms.
const GROUP_SIZE = 4
const GROUPS = MAX_TILES / GROUP_SIZE // 3
const COLS = GROUP_SIZE
const ROWS = 1

// Atlas tiles used to be packed edge-to-edge at 1 atlas-px per painting-px
// (64x48 total) — GPU mipmapping blurs a distant/angled view down to a lower
// res level, and with zero gap between tiles that blur bleeds in colors from
// the NEIGHBORING painting, reading as "extremely blurry". Fix: render each
// painting bigger (SCALE) and surround it with a PAD border that repeats its
// own edge pixels (not the neighbor's) — a blurred mip then bleeds into more
// of itself instead of into the painting next door.
const SCALE = 8 // painting-px -> atlas-px
const PAD = 8 // atlas-px of edge-repeated border around each painting
const CELL_PX = GRID * SCALE // 128
const BLOCK = CELL_PX + PAD * 2 // 144 (one painting + its border)
const AW = COLS * BLOCK // 576 (per image)
const AH = ROWS * BLOCK // 144 (per image)

// Must match PALETTE in src/game/state.ts (index 0 = eraser / blank).
const PALETTE: Array<[number, number, number]> = [
  [252, 252, 252],
  [28, 28, 31],
  [250, 250, 245],
  [212, 61, 54],
  [230, 135, 51],
  [240, 201, 71],
  [77, 163, 97],
  [66, 115, 181],
  [128, 92, 168],
  [133, 97, 69],
  [235, 128, 168],
  [250, 204, 158],
]

const WORD_BLOCKLIST = [
  "fuck", "shit", "cunt", "nigger", "nigga", "faggot", "rape", "penis", "cock", "dick",
  "pussy", "bitch", "whore", "slut", "nazi", "hitler",
]

interface Painting {
  id: string
  word: string
  cells: number[]
  author: string
  ts: number
}

// ── HTTP helpers ────────────────────────────────────────────────────────────────

function corsHeaders(extra?: Record<string, string>): Headers {
  const h = new Headers(extra)
  h.set("Access-Control-Allow-Origin", "*")
  h.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
  h.set("Access-Control-Allow-Headers", "Content-Type")
  return h
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json" }),
  })
}

// ── PNG encoder (real deflate via the platform CompressionStream, no deps) ──────
//
// The atlas used to be tiny (64x48) so "stored" (uncompressed) deflate blocks
// fit under Deno KV's 64KB-per-value limit. The padded/upscaled atlas (576x432,
// see SCALE/PAD above) is ~750KB raw — WAY over that limit stored uncompressed.
// Pixel art is almost all flat color runs, so real deflate compresses it to a
// small fraction of that. `CompressionStream('deflate')` gives a complete,
// correctly-framed zlib stream (header + Adler32 included) for free — no need
// to hand-roll adler32 or block framing like the old stored-mode version did.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
}

function pngChunk(type: string, data: number[]): number[] {
  const typed = [...type].map((ch) => ch.charCodeAt(0))
  const body = typed.concat(data)
  const crc = crc32(Uint8Array.from(body))
  return u32be(data.length).concat(body, u32be(crc))
}

async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate") // zlib-wrapped, exactly what PNG's IDAT needs
  const writer = cs.writable.getWriter()
  writer.write(data)
  writer.close()
  const chunks: Uint8Array[] = []
  const reader = cs.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

async function encodePNG(w: number, h: number, raw: Uint8Array): Promise<Uint8Array> {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  const ihdr = u32be(w).concat(u32be(h), [8, 2, 0, 0, 0]) // 8-bit, RGB
  const idat = await deflateZlib(raw)

  const bytes = sig
    .concat(pngChunk("IHDR", ihdr))
    .concat(pngChunk("IDAT", Array.from(idat)))
    .concat(pngChunk("IEND", []))
  return Uint8Array.from(bytes)
}

async function buildAtlasPNG(tiles: number[][]): Promise<Uint8Array> {
  const stride = 1 + AW * 3
  const raw = new Uint8Array(AH * stride)
  for (let y = 0; y < AH; y++) {
    const rowStart = y * stride
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < AW; x++) {
      const blockCol = Math.floor(x / BLOCK)
      const blockRow = Math.floor(y / BLOCK)
      const lx = x - blockCol * BLOCK
      const ly = y - blockRow * BLOCK
      // Clamp into the painted region — pixels in the PAD border sample the
      // nearest edge pixel of this SAME painting, not the neighboring one.
      const sx = Math.min(CELL_PX - 1, Math.max(0, lx - PAD))
      const sy = Math.min(CELL_PX - 1, Math.max(0, ly - PAD))
      const px = Math.floor(sx / SCALE)
      const py = Math.floor(sy / SCALE)
      const tileIdx = blockRow * COLS + blockCol
      const cellsForTile = tiles[tileIdx]
      let rgb: [number, number, number]
      if (cellsForTile) {
        const ci = cellsForTile[py * GRID + px] ?? 0
        rgb = ci === 0 ? [255, 255, 255] : (PALETTE[ci] ?? PALETTE[0]) // blank = clean white
      } else {
        rgb = [40, 44, 52] // empty slot
      }
      const o = rowStart + 1 + x * 3
      raw[o] = rgb[0]
      raw[o + 1] = rgb[1]
      raw[o + 2] = rgb[2]
    }
  }
  return await encodePNG(AW, AH, raw)
}

/** One painting as a PNG, pixel-scaled up by `scale`. */
async function buildTilePNG(cells: number[], scale: number): Promise<Uint8Array> {
  const w = GRID * scale
  const stride = 1 + w * 3
  const raw = new Uint8Array(w * stride)
  for (let y = 0; y < w; y++) {
    const rowStart = y * stride
    raw[rowStart] = 0
    for (let x = 0; x < w; x++) {
      const ci = cells[Math.floor(y / scale) * GRID + Math.floor(x / scale)] ?? 0
      const rgb: [number, number, number] = ci === 0 ? [255, 255, 255] : (PALETTE[ci] ?? PALETTE[0])
      const o = rowStart + 1 + x * 3
      raw[o] = rgb[0]
      raw[o + 1] = rgb[1]
      raw[o + 2] = rgb[2]
    }
  }
  return await encodePNG(w, w, raw)
}

// ── Data ───────────────────────────────────────────────────────────────────────

async function newestPaintings(limit: number): Promise<Painting[]> {
  const out: Painting[] = []
  const it = kv.list<Painting>({ prefix: ["painting"] }, { reverse: true, limit: limit * 4 })
  for await (const entry of it) {
    const p = entry.value
    const hidden = (await kv.get(["hidden", p.id])).value
    if (hidden) continue
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}

const ATLAS_VERSIONS_KEPT = 5 // bound KV growth — each blob is only ~6-9KB, but keep it finite

async function rebuildAtlas(): Promise<void> {
  const paintings = await newestPaintings(MAX_TILES)
  const ver = Date.now()
  // Store each group's PNG keyed BY (version, group) rather than overwriting
  // a single shared blob. A `/gallery` response hands out atlasUrls built
  // from `ver` paired with a `tiles` list snapshotted at this exact instant —
  // if images were stored under shared keys, a client whose /gallery fetch
  // landed a moment before this rebuild (old ver, old tiles) but whose
  // /atlas.png fetch landed a moment after (new image already written) would
  // get the OLD tiles list rendered against the NEW image — a genuine
  // painting/word mismatch on the world canvas. Worse, that response is sent
  // with `immutable` cache headers, so a client's slower/more latency-prone
  // request pattern could lock in the wrong image FOREVER for that url.
  // Versioned storage makes every previously-issued atlasUrl permanently
  // correct regardless of timing.
  for (let g = 0; g < GROUPS; g++) {
    const slice = paintings.slice(g * GROUP_SIZE, (g + 1) * GROUP_SIZE)
    const png = await buildAtlasPNG(slice.map((p) => p.cells))
    await kv.set(["atlas", ver, g], png)
  }
  await kv.set(["atlasMeta"], {
    ver,
    // `cells` lets the scene render a pixel-perfect close-up (flat-colored UI
    // squares) instead of the small, mip-blurred world texture.
    tiles: paintings.map((p) => ({ id: p.id, word: p.word, cells: p.cells })),
  })
  // Each version now has GROUPS blobs (one per image) — keep the newest
  // ATLAS_VERSIONS_KEPT versions' worth.
  const old = kv.list<Uint8Array>({ prefix: ["atlas"] }, { reverse: true })
  let kept = 0
  for await (const entry of old) {
    kept++
    if (kept > ATLAS_VERSIONS_KEPT * GROUPS) await kv.delete(entry.key)
  }
}

// ── Route handlers ─────────────────────────────────────────────────────────────

function publicOrigin(req: Request): string {
  const env = Deno.env.get("PUBLIC_URL")
  if (env) return env.replace(/\/$/, "")
  const url = new URL(req.url)
  // Behind Railway's proxy the container sees http://; the scene needs https://.
  const proto = req.headers.get("x-forwarded-proto") ?? (url.hostname === "localhost" ? "http" : "https")
  return `${proto}://${req.headers.get("x-forwarded-host") ?? url.host}`
}

async function getGallery(req: Request): Promise<Response> {
  const meta = (await kv.get<{ ver: number; tiles: Array<{ id: string; word: string; cells: number[] }> }>(
    ["atlasMeta"],
  )).value ?? { ver: 0, tiles: [] }
  const origin = publicOrigin(req)
  const atlasUrls = Array.from({ length: GROUPS }, (_, g) => `${origin}/atlas.png?v=${meta.ver}&g=${g}`)
  return json({ atlasUrls, tiles: meta.tiles })
}

async function getAtlas(url: URL): Promise<Response> {
  const v = url.searchParams.get("v")
  const ver = v ? Number(v) : NaN
  const g = Number(url.searchParams.get("g") ?? "0")
  // Serve the EXACT version requested when the caller passed one (this is
  // what makes every issued atlasUrl permanently correct — see rebuildAtlas).
  // No v, or that version no longer kept -> fall back to whatever's newest.
  let png = Number.isFinite(ver) ? (await kv.get<Uint8Array>(["atlas", ver, g])).value : undefined
  if (!png) {
    const meta = (await kv.get<{ ver: number }>(["atlasMeta"])).value
    if (meta) png = (await kv.get<Uint8Array>(["atlas", meta.ver, g])).value
  }
  if (!png) return new Response("no atlas yet", { status: 404, headers: corsHeaders() })
  return new Response(png, {
    headers: corsHeaders({
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    }),
  })
}

async function postPainting(req: Request): Promise<Response> {
  let body: { word?: unknown; cells?: unknown; author?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: "bad json" }, 400)
  }

  const word = String(body.word ?? "").trim().toLowerCase()
  const cells = body.cells
  const author = String(body.author ?? "anon").slice(0, 40)

  if (word.length < 1 || word.length > 24 || !/^[a-z0-9 ]+$/.test(word)) {
    return json({ error: "word must be 1-24 chars, letters/digits/spaces" }, 400)
  }
  if (WORD_BLOCKLIST.some((bad) => word.includes(bad))) {
    return json({ error: "word rejected" }, 400)
  }
  if (!Array.isArray(cells) || cells.length !== CELLS) {
    return json({ error: `cells must be an array of ${CELLS}` }, 400)
  }
  const clean = (cells as unknown[]).map((v) => {
    const n = Number(v) | 0
    return n >= 0 && n < PALETTE.length ? n : 0
  })

  const id = crypto.randomUUID().slice(0, 8)
  const ts = Date.now()
  const painting: Painting = { id, word, cells: clean, author, ts }
  await kv.set(["painting", ts, id], painting)
  await rebuildAtlas()
  return json({ ok: true, id })
}

interface ScoreRow {
  name: string
  userId: string
  correct: number
  total: number
  ts: number
}

async function postScore(req: Request): Promise<Response> {
  let body: { name?: unknown; userId?: unknown; correct?: unknown; total?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: "bad json" }, 400)
  }
  const name = String(body.name ?? "Guest").slice(0, 40) || "Guest"
  const userId = String(body.userId ?? "").toLowerCase().slice(0, 80)
  const correct = Math.max(0, Math.min(999, Number(body.correct ?? 0) | 0))
  const total = Math.max(0, Math.min(999, Number(body.total ?? 0) | 0))

  // One row per real player (keyed by wallet id), keeping their best run.
  // Players with no resolved identity get a throwaway row each time.
  const key = userId ? ["score", userId] : ["score", "anon:" + crypto.randomUUID().slice(0, 8)]
  const existing = (await kv.get<ScoreRow>(key)).value
  if (!existing || correct > existing.correct) {
    await kv.set(key, { name, userId, correct, total, ts: Date.now() } satisfies ScoreRow)
  }
  return json({ ok: true })
}

async function getLeaderboard(): Promise<Response> {
  const rows: Array<{ name: string; correct: number; userId: string }> = []
  const it = kv.list<Partial<ScoreRow>>({ prefix: ["score"] }, { limit: 5000 })
  for await (const entry of it) {
    const v = entry.value
    rows.push({ name: v.name ?? "Guest", correct: v.correct ?? 0, userId: v.userId ?? "" })
  }
  rows.sort((a, b) => b.correct - a.correct)
  return json(rows.slice(0, 25))
}

async function wipeScores(url: URL): Promise<Response> {
  if (url.searchParams.get("key") !== ADMIN_KEY) return json({ error: "forbidden" }, 403)
  let n = 0
  const it = kv.list({ prefix: ["score"] }, { limit: 10000 })
  for await (const entry of it) {
    await kv.delete(entry.key)
    n++
  }
  return json({ ok: true, deleted: n })
}

async function deletePainting(id: string, url: URL): Promise<Response> {
  if (url.searchParams.get("key") !== ADMIN_KEY) return json({ error: "forbidden" }, 403)
  await kv.set(["hidden", id], true)
  await rebuildAtlas()
  return json({ ok: true, hidden: id })
}

async function unhidePainting(id: string, url: URL): Promise<Response> {
  if (url.searchParams.get("key") !== ADMIN_KEY) return json({ error: "forbidden" }, 403)
  await kv.delete(["hidden", id])
  await rebuildAtlas()
  return json({ ok: true, restored: id })
}

async function getPaintingPNG(id: string): Promise<Response> {
  const it = kv.list<Painting>({ prefix: ["painting"] }, { reverse: true, limit: 5000 })
  for await (const e of it) {
    if (e.value.id === id) {
      return new Response(await buildTilePNG(e.value.cells, 12), {
        headers: corsHeaders({ "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" })
      })
    }
  }
  return new Response("not found", { status: 404, headers: corsHeaders() })
}

async function adminList(url: URL): Promise<Response> {
  if (url.searchParams.get("key") !== ADMIN_KEY) return json({ error: "forbidden" }, 403)
  const live = new Set((await newestPaintings(MAX_TILES)).map((p) => p.id))
  const rows: Array<Record<string, unknown>> = []
  const it = kv.list<Painting>({ prefix: ["painting"] }, { reverse: true, limit: 5000 })
  for await (const e of it) {
    const p = e.value
    const hidden = Boolean((await kv.get(["hidden", p.id])).value)
    rows.push({ id: p.id, word: p.word, author: p.author, ts: p.ts, hidden, live: live.has(p.id) })
  }
  return json({ count: rows.length, paintings: rows })
}

function adminPage(): Response {
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gallery admin</title><style>',
    'body{font:14px system-ui,sans-serif;margin:0;background:#12151a;color:#e8e8e8}',
    'header{padding:14px 18px;background:#0d0f13;border-bottom:1px solid #262b33;position:sticky;top:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    'input{font:14px system-ui;padding:8px 10px;border-radius:6px;border:1px solid #333;background:#1b1f26;color:#eee;width:300px}',
    'button{font:13px system-ui;padding:7px 12px;border-radius:6px;border:0;cursor:pointer;color:#fff;background:#2b6cb0}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;padding:18px}',
    '.card{background:#1b1f26;border:1px solid #262b33;border-radius:10px;padding:10px;text-align:center}',
    '.card img{width:100%;image-rendering:pixelated;border-radius:6px;background:#fff}',
    '.w{font-weight:600;margin:8px 0 2px;text-transform:uppercase;letter-spacing:.5px}',
    '.m{color:#8b93a1;font-size:12px}',
    '.tag{display:inline-block;font-size:10px;padding:2px 6px;border-radius:4px;margin:4px 2px 0}',
    '.live{background:#1d4a2b}.hid{background:#5a2020}',
    '.card button{margin-top:8px;width:100%}.del{background:#7a2222}.res{background:#245c8a}',
    '</style></head><body>',
    '<header><b>Gallery admin</b><input id="k" type="password" placeholder="admin key">',
    '<button id="go">load</button><span id="s" class="m"></span></header>',
    '<div id="g" class="grid"></div>',
    '<script>',
    'var K=function(){return document.getElementById("k").value.trim()};',
    'if(localStorage.k)document.getElementById("k").value=localStorage.k;',
    'async function load(){',
    ' localStorage.k=K();var s=document.getElementById("s");s.textContent="loading...";',
    ' var r=await fetch("/admin/list?key="+encodeURIComponent(K()));',
    ' if(!r.ok){s.textContent=r.status===403?"wrong key":"error";return}',
    ' var d=await r.json();s.textContent=d.count+" paintings, "+d.paintings.filter(function(p){return p.live}).length+" live";',
    ' var g=document.getElementById("g");g.innerHTML="";',
    ' d.paintings.forEach(function(p){',
    '  var c=document.createElement("div");c.className="card";',
    '  var b=document.createElement("button");',
    '  b.className=p.hidden?"res":"del";b.textContent=p.hidden?"restore":"delete";',
    '  b.onclick=function(){act(p.id,p.hidden?"restore":"delete")};',
    '  c.innerHTML=\'<img loading="lazy" src="/painting/\'+p.id+\'.png"><div class="w">\'+p.word+\'</div>\'',
    '   +\'<div class="m">\'+(p.author||"anon")+" - "+new Date(p.ts).toLocaleDateString()+"</div>"',
    '   +(p.live?\'<span class="tag live">LIVE</span>\':"")+(p.hidden?\'<span class="tag hid">HIDDEN</span>\':"");',
    '  c.appendChild(b);g.appendChild(c);',
    ' });',
    '}',
    'async function act(id,kind){',
    ' if(kind==="delete"&&!confirm("Delete this painting?"))return;',
    ' var m=kind==="delete"?"DELETE":"GET";',
    ' var u=kind==="delete"?"/painting/"+id+"?key=":"/painting/"+id+"/restore?key=";',
    ' var r=await fetch(u+encodeURIComponent(K()),{method:m});',
    ' if(r.ok)load();else alert("failed");',
    '}',
    'document.getElementById("go").onclick=load;',
    'if(localStorage.k)load();',
    '</script></body></html>'
  ].join('\n')
  return new Response(html, { headers: corsHeaders({ "Content-Type": "text/html; charset=utf-8" }) })
}

// ── Server ─────────────────────────────────────────────────────────────────────

// Keep the baked atlas in sync with the current rendering code on every boot.
await rebuildAtlas().catch((e) => console.error("startup rebuildAtlas failed:", e))

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req: Request) => {
  const url = new URL(req.url)
  const path = url.pathname

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() })

  try {
    if (path === "/") return json({ ok: true, service: "dcl-gallery" })
    if (path === "/gallery" && req.method === "GET") return await getGallery(req)
    if (path === "/atlas.png" && req.method === "GET") return await getAtlas(url)
    if (path === "/painting" && req.method === "POST") return await postPainting(req)
    if (path === "/score" && req.method === "POST") return await postScore(req)
    if (path === "/score" && req.method === "DELETE") return await wipeScores(url)
    if (path === "/leaderboard" && req.method === "GET") return await getLeaderboard()
    if (path === "/admin" && req.method === "GET") return adminPage()
    if (path === "/admin/list" && req.method === "GET") return await adminList(url)
    if (path.endsWith(".png") && path.startsWith("/painting/") && req.method === "GET") {
      return await getPaintingPNG(path.slice("/painting/".length, -4))
    }
    if (path.endsWith("/restore") && path.startsWith("/painting/") && req.method === "GET") {
      return await unhidePainting(path.slice("/painting/".length, -"/restore".length), url)
    }
    if (path.startsWith("/painting/") && req.method === "DELETE") {
      return await deletePainting(path.slice("/painting/".length), url)
    }
    return json({ error: "not found" }, 404)
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
