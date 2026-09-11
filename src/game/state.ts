/**
 * Shared game state — synced across all players with `syncEntity` (serverless CRDT).
 *
 * Authority model: there is no server. One player is elected "host" (lowest wallet
 * address present) and is the ONLY client that advances phases, rotates the drawer,
 * validates guesses and writes scores. Every other client just reads this state and
 * renders it. See game.ts for the host loop.
 *
 * NOTE: `GameState.word` travels to every client, so a determined guesser could read
 * it from memory. That is inherent to serverless sync — the fix is the Multiplayer
 * Server (see the authoritative-server skill). Fine for this prototype.
 */

import { engine, Schemas } from '@dcl/sdk/ecs'
import { syncEntity, myProfile } from '@dcl/sdk/network'
import { getPlayer } from '@dcl/sdk/players'
import { Color4 } from '@dcl/sdk/math'

// ── Tuning ──────────────────────────────────────────────────────────────────────
export const GRID = 16 // 256 cells — at the entity budget; more = lag
export const CELL_COUNT = GRID * GRID

export const LOBBY_MS = 6_000 // grace once enough players are in, so more can join
export const CHOOSE_MS = 10_000
export const DRAW_MS = 75_000
export const REVEAL_MS = [30_000, 60_000]
export const ROUND_END_MS = 6_000
export const GAME_OVER_MS = 12_000
export const ROTATIONS = 2 // how many times each player draws per game
// 1 = the game can start with a single connected player (rounds just time out
// with nobody guessing). It's still the full multiplayer code path — set to 2+
// to require real guessers before a game begins.
export const MIN_PLAYERS = 1
export const MAX_PLAYERS = 8

export enum Phase {
  Lobby = 0,
  Choosing = 1,
  Drawing = 2,
  RoundEnd = 3,
  GameOver = 4
}

export const WORDS = Array.from(new Set([
  'frog', 'house', 'apple', 'star', 'fish', 'tree', 'car', 'sun', 'boat', 'clock',
  'snake', 'key', 'cup', 'hat', 'book', 'bird', 'cat', 'moon', 'flower', 'heart',
  'cloud', 'duck', 'shoe', 'bell', 'leaf', 'kite', 'drum', 'ring', 'crown', 'ghost',
  'robot', 'pizza', 'guitar', 'rocket', 'ladder', 'anchor', 'camera', 'balloon',
  'sword', 'crab', 'tent', 'axe', 'eye', 'bone', 'wheel', 'spider', 'lamp', 'gift',
  'dog', 'horse', 'bear', 'lion', 'owl', 'bee', 'ant', 'whale', 'shark', 'turtle',
  'rabbit', 'mouse', 'pig', 'cow', 'sheep', 'fox', 'penguin', 'dolphin', 'octopus', 'butterfly',
  'snail', 'worm', 'dragon', 'dinosaur', 'unicorn', 'mushroom', 'cactus', 'palm', 'rose', 'acorn',
  'mountain', 'volcano', 'island', 'river', 'rainbow', 'snowman', 'campfire', 'igloo', 'castle', 'bridge',
  'train', 'plane', 'bus', 'bike', 'truck', 'ship', 'submarine', 'tractor', 'helicopter', 'sailboat',
  'chair', 'table', 'bed', 'door', 'window', 'clock', 'candle', 'lantern', 'umbrella', 'mirror',
  'scissors', 'hammer', 'saw', 'nail', 'brush', 'pencil', 'crayon', 'paperclip', 'magnet', 'battery',
  'phone', 'computer', 'television', 'headphones', 'clock', 'watch', 'compass', 'telescope', 'microscope', 'lightbulb',
  'burger', 'hotdog', 'donut', 'cake', 'icecream', 'cookie', 'banana', 'grapes', 'carrot', 'cheese',
  'egg', 'bread', 'popcorn', 'lollipop', 'cherry', 'strawberry', 'watermelon', 'pumpkin', 'pineapple', 'lemon',
  'sock', 'glove', 'scarf', 'boot', 'tie', 'button', 'zipper', 'backpack', 'wallet', 'glasses',
  'football', 'basketball', 'baseball', 'tennis', 'skateboard', 'kite', 'yoyo', 'dice', 'chess', 'puzzle',
  'guitar', 'piano', 'trumpet', 'violin', 'microphone', 'note', 'flag', 'trophy', 'medal', 'ticket',
  'snowflake', 'lightning', 'tornado', 'raindrop', 'planet', 'comet', 'satellite', 'alien', 'ufo', 'astronaut',
  'skull', 'pirate', 'wizard', 'king', 'queen', 'knight', 'clown', 'ninja', 'mermaid', 'angel',
  'tooth', 'foot', 'hand', 'nose', 'ear', 'lips', 'brain', 'skeleton', 'footprint', 'fingerprint',
  'key', 'lock', 'chain', 'rope', 'net', 'hook', 'bucket', 'shovel', 'broom', 'ladder',
  'map', 'letter', 'stamp', 'envelope', 'newspaper', 'calendar', 'scroll', 'diamond', 'coin', 'treasure'
]))

// Deliberately not 1/2/3 — a stale comms session from earlier testing kept
// rejecting those as "already in use" even on a verified-fresh client, which
// points at the room/relay layer remembering them rather than anything local.
// Fresh numbers sidestep it outright.
enum SyncId {
  GameState = 5001,
  Roster = 5002,
  Grid = 5003
}

// ── Brush palette (index 0 = eraser / blank) ────────────────────────────────────
export const PALETTE: { name: string; color: Color4 }[] = [
  { name: 'Eraser', color: Color4.create(0.99, 0.99, 0.99, 1) },
  { name: 'Black', color: Color4.create(0.11, 0.11, 0.12, 1) },
  { name: 'White', color: Color4.create(0.98, 0.98, 0.96, 1) },
  { name: 'Red', color: Color4.create(0.83, 0.24, 0.21, 1) },
  { name: 'Orange', color: Color4.create(0.9, 0.53, 0.2, 1) },
  { name: 'Yellow', color: Color4.create(0.94, 0.79, 0.28, 1) },
  { name: 'Green', color: Color4.create(0.3, 0.64, 0.38, 1) },
  { name: 'Blue', color: Color4.create(0.26, 0.45, 0.71, 1) },
  { name: 'Purple', color: Color4.create(0.5, 0.36, 0.66, 1) },
  { name: 'Brown', color: Color4.create(0.52, 0.38, 0.27, 1) },
  { name: 'Pink', color: Color4.create(0.92, 0.5, 0.66, 1) },
  { name: 'Skin', color: Color4.create(0.98, 0.8, 0.62, 1) }
]

const CHECK_A = Color4.create(0.99, 0.99, 0.99, 1)
const CHECK_B = Color4.create(0.88, 0.88, 0.88, 1)
export function blankColor(row: number, col: number): Color4 {
  return (row + col) % 2 === 0 ? CHECK_A : CHECK_B
}

// ── Synced components ───────────────────────────────────────────────────────────
export const GameState = engine.defineComponent('gtw::gameState', {
  phase: Schemas.EnumNumber<Phase>(Phase, Phase.Lobby),
  phaseStartAt: Schemas.Int64, // Date.now() when the current phase timer started
  hostId: Schemas.String,
  drawerId: Schemas.String,
  word: Schemas.String, // '' until the drawer picks
  choices: Schemas.Array(Schemas.String), // the 3 options during Choosing
  revealed: Schemas.Array(Schemas.Boolean), // per-letter reveal mask
  round: Schemas.Int, // 1-based; goes up to totalRounds
  totalRounds: Schemas.Int
})

export const Roster = engine.defineComponent('gtw::roster', {
  ids: Schemas.Array(Schemas.String), // joined players, in draw order
  names: Schemas.Array(Schemas.String), // parallel to ids
  scores: Schemas.Array(Schemas.Int), // parallel to ids — cumulative
  roundPoints: Schemas.Array(Schemas.Int), // parallel to ids — this round only
  guessed: Schemas.Array(Schemas.String) // ids that guessed correctly this round
})

export const Grid = engine.defineComponent('gtw::grid', {
  cells: Schemas.Array(Schemas.Int) // length CELL_COUNT, palette index per pixel
})

// ── Singleton handles ──────────────────────────────────────────────────────────
let stateE = engine.RootEntity
let rosterE = engine.RootEntity
let gridE = engine.RootEntity

let synced = false

/**
 * Idempotent within one running scene session — guards against a second call
 * (e.g. a re-triggered enterMultiplayer) trying to register the same sync ids
 * twice, which `syncEntity` rejects. `synced` only flips once every syncEntity
 * call below has actually succeeded — flip it early and a failed first
 * attempt would permanently no-op every retry while leaving stateE/rosterE/
 * gridE unset, which is worse than the original error (every read after that
 * throws "component not found" on RootEntity instead).
 *
 * Doesn't help across a stale hot-reload where the *engine* still remembers
 * ids from a previous scene load — that needs a full client restart, not a
 * code fix.
 */
export function initSync(): void {
  if (synced) return

  stateE = engine.addEntity()
  GameState.create(stateE, {
    phase: Phase.Lobby,
    phaseStartAt: 0,
    hostId: '',
    drawerId: '',
    word: '',
    choices: [],
    revealed: [],
    round: 0,
    totalRounds: 0
  })
  syncEntity(stateE, [GameState.componentId], SyncId.GameState)

  rosterE = engine.addEntity()
  Roster.create(rosterE, { ids: [], names: [], scores: [], roundPoints: [], guessed: [] })
  syncEntity(rosterE, [Roster.componentId], SyncId.Roster)

  gridE = engine.addEntity()
  Grid.create(gridE, { cells: new Array(CELL_COUNT).fill(0) })
  syncEntity(gridE, [Grid.componentId], SyncId.Grid)

  synced = true // only now — every syncEntity call above actually succeeded
}

export const state = () => GameState.get(stateE)
export const stateMut = () => GameState.getMutable(stateE)
export const roster = () => Roster.get(rosterE)
export const rosterMut = () => Roster.getMutable(rosterE)
export const grid = () => Grid.get(gridE)
export const gridMut = () => Grid.getMutable(gridE)

// ── Local player identity ──────────────────────────────────────────────────────
let stableId = ''
const bootedAt = Date.now()
export function myId(): string {
  if (stableId) return stableId
  const real = (getPlayer()?.userId || myProfile?.userId || '').toLowerCase()
  if (real) {
    stableId = real
    return stableId
  }
  // Last-resort id for a client whose wallet/profile never resolves (offline
  // preview). 12s is well past when a real connection resolves, so this never
  // fires in real multiplayer — where a stable shared id is required.
  if (Date.now() - bootedAt > 12000) {
    stableId = 'guest-' + Math.floor(Math.random() * 1e6).toString(36)
    return stableId
  }
  return ''
}
export function myName(): string {
  const n = getPlayer()?.name
  if (n) return n
  const id = myId()
  return id ? `Player ${id.replace(/^0x|^guest-/, '').slice(0, 4)}` : 'Player'
}

// ── Derived helpers ────────────────────────────────────────────────────────────
export function phaseDurationMs(p: Phase): number {
  switch (p) {
    case Phase.Lobby: return LOBBY_MS
    case Phase.Choosing: return CHOOSE_MS
    case Phase.Drawing: return DRAW_MS
    case Phase.RoundEnd: return ROUND_END_MS
    case Phase.GameOver: return GAME_OVER_MS
    default: return 0
  }
}

export function remainingMs(): number {
  const st = state()
  const d = phaseDurationMs(st.phase)
  if (!d) return 0
  return Math.max(0, d - (Date.now() - Number(st.phaseStartAt)))
}

export function rosterIndex(id: string): number {
  return roster().ids.findIndex((x) => x === id)
}

export function scoreOf(id: string): number {
  const i = rosterIndex(id)
  return i < 0 ? 0 : roster().scores[i] ?? 0
}

export function iAmDrawer(): boolean {
  return state().drawerId !== '' && state().drawerId === myId()
}

export function iHaveJoined(): boolean {
  return rosterIndex(myId()) >= 0
}

export function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function maskedWord(): string {
  const st = state()
  if (!st.word) return ''
  let out = ''
  for (let i = 0; i < st.word.length; i++) {
    out += (st.revealed[i] ? st.word[i].toUpperCase() : '_') + (i < st.word.length - 1 ? ' ' : '')
  }
  return out
}
