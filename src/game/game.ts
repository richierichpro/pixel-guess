/**
 * The "brain": host election + authoritative round loop + guess handling + join/leave.
 *
 * Only the elected host mutates GameState / Roster. Everyone runs `setupGame()`, but
 * `hostSystem` early-returns on non-hosts. Join/leave and guesses are sent as
 * MessageBus events; the host is the only one that acts on them.
 */

import { engine } from '@dcl/sdk/ecs'
import { MessageBus } from '@dcl/sdk/message-bus'
import { isStateSyncronized } from '@dcl/sdk/network'
import { onLeaveScene } from '@dcl/sdk/players'
import {
  Phase,
  WORDS,
  GRID,
  CELL_COUNT,
  LOBBY_MS,
  CHOOSE_MS,
  DRAW_MS,
  REVEAL_MS,
  ROUND_END_MS,
  GAME_OVER_MS,
  MIN_PLAYERS,
  MAX_PLAYERS,
  ROTATIONS,
  state,
  stateMut,
  roster,
  rosterMut,
  grid,
  gridMut,
  myId,
  myName,
  normalizeWord,
  rosterIndex
} from './state'
import { play } from '../sound'

const bus = new MessageBus()

type JoinMsg = { id: string; name: string }
type LeaveMsg = { id: string }
type GuessMsg = { id: string; name: string; text: string }
type PickMsg = { id: string; word: string }
export type GuessResult = { id: string; name: string; correct: boolean; text: string }

// Latest guess results, for the HUD feed (all clients).
export const guessFeed: GuessResult[] = []

let ready = false
let bootAt = 0

export function setupGame(): void {
  bootAt = Date.now()
  bus.on('gtw:join', (m: JoinMsg) => hostHandleJoin(m))
  bus.on('gtw:leave', (m: LeaveMsg) => removePlayer(m.id))
  bus.on('gtw:guess', (m: GuessMsg) => hostHandleGuess(m))
  bus.on('gtw:pick', (m: PickMsg) => hostHandlePick(m))
  bus.on('gtw:result', (r: GuessResult) => {
    guessFeed.push(r)
    if (guessFeed.length > 6) guessFeed.shift()
    if (r.correct) play(r.id === myId() ? 'youGotIt' : 'correct')
    else if (r.id === myId()) play('wrong') // only your own miss buzzes
  })

  // Anyone can drop a player who actually left the scene — removePlayer is
  // idempotent, so it's safe even when the host also processes it. This avoids a
  // deadlock when the player who left WAS the host.
  onLeaveScene((userId) => removePlayer(userId.toLowerCase()))

  ready = true
  engine.addSystem(hostSystem)
  engine.addSystem(soundWatchSystem)
  engine.addSystem(rejoinWatchSystem)
}

// ── Local sound cues — every client watches synced state for edges ─────────────
// (not host-gated: everyone should hear these, not just whoever's authoritative)

let sPhase = -1
let sRevealed = 0

function soundWatchSystem(): void {
  const st = state()
  if (st.phase !== sPhase) {
    if (st.phase === Phase.Drawing) play('roundStart') // "go" cue (no dedicated clip)
    else if (st.phase === Phase.RoundEnd) play('timesUp')
    else if (st.phase === Phase.GameOver) play('gameOver')
    sPhase = st.phase
    sRevealed = 0
  }

  if (st.phase === Phase.Drawing) {
    const revealedCount = st.revealed.filter(Boolean).length
    if (revealedCount > sRevealed) play('reveal')
    sRevealed = revealedCount
  }
}

// ── Public actions (called from the HUD / board) ───────────────────────────────

let wantToBeJoined = false
export function requestJoin(): void {
  play('join')
  wantToBeJoined = true
  bus.emit('gtw:join', { id: myId(), name: myName() })
}
export function requestLeave(): void {
  wantToBeJoined = false
  bus.emit('gtw:leave', { id: myId() })
}

// A dropped connection (mobile network hiccup, etc.) fires onLeaveScene on
// OTHER clients, which removes the affected player from the synced roster —
// but the player's own client is often still running and has no idea it got
// dropped; it just silently becomes a spectator (can't type guesses) until
// someone notices and taps JOIN again. Self-heal: if this client explicitly
// asked to be in the game and a live round is running but the roster
// disagrees, re-send the join. Throttled so a legitimately-rejected join
// (room full) doesn't spam retries forever.
let lastRejoinAttempt = 0
function rejoinWatchSystem(): void {
  if (!wantToBeJoined || rosterIndex(myId()) >= 0) return
  if (state().phase === Phase.Lobby) return // normal to not be joined yet
  const now = Date.now()
  if (now - lastRejoinAttempt < 4000) return
  lastRejoinAttempt = now
  bus.emit('gtw:join', { id: myId(), name: myName() })
}
export function submitGuess(text: string): void {
  const t = text.trim()
  if (!t) return
  bus.emit('gtw:guess', { id: myId(), name: myName(), text: t })
}
/** Drawer picks one of the three words — the host writes it and starts drawing. */
export function pickWord(word: string): void {
  const st = state()
  if (st.phase !== Phase.Choosing || st.drawerId !== myId()) return
  if (!st.choices.includes(word)) return
  bus.emit('gtw:pick', { id: myId(), word })
}

// ── Drawing (only the current drawer may paint) ────────────────────────────────

export function canDraw(): boolean {
  return state().phase === Phase.Drawing && state().drawerId === myId()
}

export function paintPixel(index: number, colorIndex: number): void {
  paintCells([index], colorIndex)
}

/** Paint many pixels in one synced write (brush size, mirror, …). */
export function paintCells(indices: number[], colorIndex: number): void {
  if (!canDraw()) return
  const next = grid().cells.slice()
  let changed = false
  for (const i of indices) {
    if (i < 0 || i >= CELL_COUNT || (next[i] ?? 0) === colorIndex) continue
    next[i] = colorIndex
    changed = true
  }
  if (changed) gridMut().cells = next
}

export function setGrid(cells: number[]): void {
  if (!canDraw() || cells.length !== CELL_COUNT) return
  gridMut().cells = cells.slice()
}

export function clearCanvas(): void {
  if (!canDraw()) return
  gridMut().cells = new Array(CELL_COUNT).fill(0)
}

/** Bucket fill from `index`. */
export function floodFill(index: number, colorIndex: number): void {
  if (!canDraw() || index < 0 || index >= CELL_COUNT) return
  const cells = grid().cells
  const target = cells[index] ?? 0
  if (target === colorIndex) return
  const next = cells.slice()
  const stack = [index]
  while (stack.length) {
    const i = stack.pop() as number
    if ((next[i] ?? 0) !== target) continue
    next[i] = colorIndex
    const r = Math.floor(i / GRID)
    const c = i % GRID
    if (c > 0) stack.push(i - 1)
    if (c < GRID - 1) stack.push(i + 1)
    if (r > 0) stack.push(i - GRID)
    if (r < GRID - 1) stack.push(i + GRID)
  }
  gridMut().cells = next
}

// ── Host election ──────────────────────────────────────────────────────────────
//
// The host is the LEXICOGRAPHICALLY SMALLEST id currently in the synced
// roster — a pure function of the roster's CONTENTS, not its insertion
// order. No reliance on PlayerIdentityData (which populates unevenly across
// clients and was making players/hosts flicker). When the roster is still
// empty every client acts as host so the very first join messages get
// processed; once anyone is in the roster, exactly one client is host.
//
// Deliberately NOT `roster.ids[0]` (array position): two people joining
// within moments of each other can each process the join messages
// independently before the roster fully syncs, leaving each client's LOCAL
// array in a different order (e.g. [A,B] on one client, [B,A] on the other)
// even after both eventually agree on the same SET of members. If host were
// "whoever's first in MY array," each client could disagree about who's
// host and both would run the host loop — confirmed live: two players each
// got their own word to draw simultaneously. Picking the min-by-value id
// instead means both clients agree the instant they see the same SET of
// members, regardless of what order either array happens to hold them in.

// Am I the host right now? Recomputed every frame by hostSystem; message handlers
// read this flag so they agree with the loop.
let hosting = false
export function iAmHost(): boolean {
  return hosting
}

/** True once we can trust the roster is really empty and not just un-synced. */
function syncSettled(): boolean {
  return isStateSyncronized() || Date.now() - bootAt > 8000
}

function resolveHosting(): boolean {
  const me = myId()
  if (me === '') return false
  const ids = roster().ids
  if (ids.length > 0) {
    let min = ids[0]
    for (const id of ids) if (id < min) min = id
    return min === me
  }
  // Roster empty: only bootstrap-host once sync has settled, so a late joiner
  // doesn't briefly see an empty roster and fork the game state.
  return syncSettled()
}

// ── Host loop ──────────────────────────────────────────────────────────────────

function hostSystem(): void {
  if (!ready) return

  hosting = resolveHosting()
  if (!hosting) return
  if (state().hostId !== myId()) stateMut().hostId = myId()

  const st = state()
  const now = Date.now()
  const elapsed = now - Number(st.phaseStartAt)

  switch (st.phase) {
    case Phase.Lobby: {
      const enough = roster().ids.length >= MIN_PLAYERS
      if (!enough) {
        if (Number(st.phaseStartAt) !== 0) stateMut().phaseStartAt = 0 // stop the countdown
      } else if (Number(st.phaseStartAt) === 0) {
        stateMut().phaseStartAt = now // start the join-grace countdown
      } else if (now - Number(st.phaseStartAt) >= LOBBY_MS) {
        startGame(now)
      }
      break
    }

    case Phase.Choosing:
      if (rosterIndex(st.drawerId) < 0) {
        skipRound(now)
      } else if (st.word !== '') {
        beginDrawing(now)
      } else if (elapsed >= CHOOSE_MS) {
        stateMut().word = st.choices[Math.floor(Math.random() * st.choices.length)] || 'star'
        beginDrawing(now)
      }
      break

    case Phase.Drawing: {
      if (rosterIndex(st.drawerId) < 0) {
        endRound(now)
        break
      }
      const targets = REVEAL_MS.filter((m) => elapsed >= m).length
      const maxReveal = Math.min(targets, Math.max(0, st.word.length - 1))
      if (countRevealed() < maxReveal) revealOne()

      const guessers = roster().ids.filter((id) => id !== st.drawerId)
      const allGuessed = guessers.length > 0 && guessers.every((id) => roster().guessed.includes(id))
      if (elapsed >= DRAW_MS || allGuessed) endRound(now)
      break
    }

    case Phase.RoundEnd:
      if (elapsed >= ROUND_END_MS) advance(now)
      break

    case Phase.GameOver:
      if (elapsed >= GAME_OVER_MS) toLobby(now)
      break
  }
}

// ── Host: state transitions ────────────────────────────────────────────────────

function startGame(now: number): void {
  const n = roster().ids.length
  stateMut().totalRounds = n * ROTATIONS
  stateMut().round = 1
  rosterMut().scores = roster().ids.map(() => 0)
  beginChoosing(now)
}

function beginChoosing(now: number): void {
  const r = roster()
  const prevDrawer = state().drawerId
  let drawer = r.ids[(state().round - 1) % r.ids.length] ?? r.ids[0]
  // The rotation above is computed from the LIVE roster length/order, which
  // can shift under a player's feet mid-game — a network hiccup drops them
  // (onLeaveScene fires, removePlayer shrinks the roster) and they rejoin a
  // moment later, appended back at the end. If that happens right around a
  // round boundary, the "current index" can land right back on whoever just
  // drew, giving them two turns in a row while the player who blipped out
  // sits as a spectator for that round. Enforce the invariant directly
  // regardless of the exact roster churn that caused it: never repeat the
  // immediately-previous drawer when there's more than one player.
  if (r.ids.length > 1 && drawer === prevDrawer) {
    const i = r.ids.indexOf(prevDrawer)
    drawer = r.ids[(i + 1) % r.ids.length]
  }
  const st = stateMut()
  st.phase = Phase.Choosing
  st.phaseStartAt = now
  st.drawerId = drawer
  st.word = ''
  st.choices = pickThree()
  st.revealed = []
  clearGrid()
  rosterMut().guessed = []
  rosterMut().roundPoints = r.ids.map(() => 0)
}

function beginDrawing(now: number): void {
  const st = stateMut()
  st.phase = Phase.Drawing
  st.phaseStartAt = now
  st.revealed = new Array(st.word.length).fill(false)
}

function endRound(now: number): void {
  const st = state()
  // Drawer earns the average of what the correct guessers made.
  const gained: number[] = []
  roster().ids.forEach((id, i) => {
    if (id !== st.drawerId && (roster().roundPoints[i] ?? 0) > 0) gained.push(roster().roundPoints[i])
  })
  if (gained.length) {
    const avg = Math.round(gained.reduce((a, b) => a + b, 0) / gained.length)
    addPoints(st.drawerId, avg)
  }
  const m = stateMut()
  m.phase = Phase.RoundEnd
  m.phaseStartAt = now
  m.revealed = new Array(st.word.length).fill(true)
}

function skipRound(now: number): void {
  // Drawer vanished before drawing — just move on without scoring.
  const m = stateMut()
  m.phase = Phase.RoundEnd
  m.phaseStartAt = now
  m.revealed = new Array(m.word.length).fill(true)
}

function advance(now: number): void {
  const st = state()
  if (st.round >= st.totalRounds || roster().ids.length < MIN_PLAYERS) {
    stateMut().phase = Phase.GameOver
    stateMut().phaseStartAt = now
    return
  }
  stateMut().round = st.round + 1
  beginChoosing(now)
}

function toLobby(_now: number): void {
  const m = stateMut()
  m.phase = Phase.Lobby
  m.phaseStartAt = 0 // 0 = countdown not started; hostSystem starts it when enough players are in
  m.drawerId = ''
  m.word = ''
  m.choices = []
  m.revealed = []
  m.round = 0
  m.totalRounds = 0
  rosterMut().scores = roster().ids.map(() => 0)
  rosterMut().roundPoints = roster().ids.map(() => 0)
  rosterMut().guessed = []
  clearGrid()
}

// ── Host: roster + guesses ─────────────────────────────────────────────────────

function hostHandleJoin(m: JoinMsg): void {
  if (!m.id || !resolveHosting()) return
  if (rosterIndex(m.id) >= 0 || roster().ids.length >= MAX_PLAYERS) return
  rosterMut().ids = [...roster().ids, m.id]
  rosterMut().names = [...roster().names, m.name || 'Player']
  rosterMut().scores = [...roster().scores, 0]
  rosterMut().roundPoints = [...roster().roundPoints, 0]
}

function removePlayer(id: string): void {
  const i = rosterIndex(id)
  if (i < 0) return
  const drop = <T>(a: readonly T[]): T[] => a.filter((_, k) => k !== i)
  rosterMut().ids = drop(roster().ids)
  rosterMut().names = drop(roster().names)
  rosterMut().scores = drop(roster().scores)
  rosterMut().roundPoints = drop(roster().roundPoints)
  rosterMut().guessed = roster().guessed.filter((g) => g !== id)
}

function hostHandlePick(m: PickMsg): void {
  if (!iAmHost()) return
  const st = state()
  if (st.phase !== Phase.Choosing || m.id !== st.drawerId || st.word !== '') return
  if (!st.choices.includes(m.word)) return
  stateMut().word = m.word // hostSystem's Choosing case picks it up next frame
}

function hostHandleGuess(m: GuessMsg): void {
  if (!iAmHost()) return
  const st = state()
  if (st.phase !== Phase.Drawing || m.id === st.drawerId) return
  if (rosterIndex(m.id) < 0 || roster().guessed.includes(m.id)) return

  const correct = normalizeWord(m.text) === normalizeWord(st.word)
  if (!correct) {
    bus.emit('gtw:result', { id: m.id, name: m.name, correct: false, text: m.text })
    return
  }

  const secsLeft = Math.max(0, DRAW_MS - (Date.now() - Number(st.phaseStartAt))) / 1000
  const first = roster().guessed.length === 0
  const pts = Math.round((250 * secsLeft) / (DRAW_MS / 1000)) + 50 + (first ? 50 : 0)
  addPoints(m.id, pts)
  rosterMut().roundPoints = roster().roundPoints.map((p, k) => (roster().ids[k] === m.id ? pts : p))
  rosterMut().guessed = [...roster().guessed, m.id]
  bus.emit('gtw:result', { id: m.id, name: m.name, correct: true, text: '' })
}

// ── Host: small mutators ───────────────────────────────────────────────────────

function addPoints(id: string, pts: number): void {
  const i = rosterIndex(id)
  if (i < 0) return
  rosterMut().scores = roster().scores.map((s, k) => (k === i ? s + pts : s))
}

function countRevealed(): number {
  return state().revealed.filter(Boolean).length
}

function revealOne(): void {
  const rv = [...state().revealed]
  const hidden: number[] = []
  rv.forEach((v, i) => { if (!v) hidden.push(i) })
  if (hidden.length <= 1) return
  rv[hidden[Math.floor(Math.random() * hidden.length)]] = true
  stateMut().revealed = rv
}

function pickThree(): string[] {
  const pool = WORDS.slice()
  const out: string[] = []
  for (let i = 0; i < 3 && pool.length; i++) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  return out
}

function clearGrid(): void {
  gridMut().cells = new Array(CELL_COUNT).fill(0)
}
