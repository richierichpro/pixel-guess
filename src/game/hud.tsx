/**
 * 2D screen HUD + the drawing-canvas overlay.
 *
 * Drawer taps "OPEN CANVAS" → full-screen 16x16 grid (Pixelary layout: colours in
 * a column on the LEFT, tools on the RIGHT). Tap a pixel to paint; click-drag with
 * a mouse to draw a stroke. Tools: undo/redo, fill, pen, eraser, brush size,
 * mirror X/Y, clear. Guessers get "VIEW DRAWING" — the same view, read-only, with
 * the word masked and a guess box.
 *
 * Everything writes the synced Grid, so the floor board updates for everyone.
 */

import ReactEcs, { UiEntity, Label, Button, Input } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine, UiCanvasInformation, InputModifier, TouchScreenControls } from '@dcl/sdk/ecs'
import { play } from '../sound'
import {
  Phase,
  GRID,
  MIN_PLAYERS,
  MAX_PLAYERS,
  DRAW_MS,
  PALETTE,
  blankColor,
  state,
  roster,
  grid,
  myId,
  iAmDrawer,
  iHaveJoined,
  maskedWord,
  remainingMs
} from './state'
import {
  requestJoin,
  requestLeave,
  submitGuess,
  pickWord,
  paintCells,
  floodFill,
  clearCanvas,
  setGrid,
  canDraw,
  guessFeed
} from './game'

let typed = ''
let clearFlash = false
let canvasOpen = false
let showRules = false

// Optimistic local prediction: the instant the drawer picks a word, jump their
// OWN screen straight to "drawing" (canvas open, no more choosing-timer) rather
// than waiting for the pick to round-trip through the host and sync back. Only
// ever set on the picking client's own device — everyone else still correctly
// waits for the real phase change.
let myPickedWord = ''

// ── drawing tools ─────────────────────────────────────────────────────────────
let brush = 1 // palette index; 0 = eraser
let fillMode = false
let painting = false // desktop mouse-drag in progress
const undoStack: number[][] = []
const redoStack: number[][] = []

let frozen = false

/** Simple, predictable typing feedback: the character you type Nth always
 * fills dash position N, one-to-one — no skipping over revealed positions,
 * no hidden rules. Revealed hints are shown entirely separately (see
 * `hintRow`) so typing never "jumps" or gets overwritten by a hint. You type
 * the whole word yourself, hint included if you choose to use it — SUBMIT
 * just checks what you actually typed against the real word, no merging. */
function typedDashes(word: string): string {
  if (!word) return ''
  let out = ''
  for (let i = 0; i < word.length; i++) {
    const t = typed[i]
    out += t ? t.toUpperCase() : '_'
    if (i < word.length - 1) out += '   '
  }
  return out
}

/** The host's revealed hint letters, one row under the dashes — purely a
 * reference. Doesn't affect what you type or how SUBMIT is checked. */
function hintRow(word: string, revealed: readonly boolean[]): string {
  if (!word) return ''
  let out = ''
  for (let i = 0; i < word.length; i++) {
    out += revealed[i] ? word[i].toUpperCase() : ' '
    if (i < word.length - 1) out += '   '
  }
  return out
}

/** The multiplayer game's screen UI. Mounted by the root renderer in ui.tsx. */
export const gameHud = () => hud()

export function setupHud(): void {
  engine.addSystem(freezeSystem)
}

// canvasOpen/myPickedWord are only ever cleared from inside hud()'s OWN
// render body (below) — which stops running the instant the screen leaves
// Multiplayer. If the player clicked a word/OPEN CANVAS/VIEW DRAWING button
// and then navigated away (menu, single-player, anywhere) before the round
// naturally reached RoundEnd/GameOver/Lobby, those flags stay stuck `true`
// forever — and since freezeSystem runs on EVERY screen (registered once at
// boot, not gated to Multiplayer), the freeze it applies never gets
// released, permanently locking movement AND camera look in every other mode
// too. `app.ts` calls this on entry to GUESS/DRAW to force-clear it —
// exported from here (not the reverse: hud.tsx must never import from
// app.ts, that's a circular import back into a module app.ts is still
// mid-evaluating when it reaches `import { setupHud } from './game/hud'`,
// which can hand back permanently-broken/undefined bindings depending on how
// the bundler resolves the cycle — confirmed to break the whole scene).
export function releaseMultiplayerFreeze(): void {
  canvasOpen = false
  myPickedWord = ''
  if (frozen) {
    InputModifier.deleteFrom(engine.PlayerEntity)
    TouchScreenControls.showJoystick()
    TouchScreenControls.showAll()
    frozen = false
  }
}

/** Freeze the avatar + hide touch controls while the drawing canvas is open. */
function freezeSystem(): void {
  const on = canvasOpen && (state().phase === Phase.Drawing || myPickedWord !== '')
  if (on && !frozen) {
    InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
    TouchScreenControls.hideJoystick()
    TouchScreenControls.hideAll()
    frozen = true
  } else if (!on && frozen) {
    InputModifier.deleteFrom(engine.PlayerEntity)
    TouchScreenControls.showJoystick()
    TouchScreenControls.showAll()
    frozen = false
  }
}

// ── paint helpers ─────────────────────────────────────────────────────────────
// The checkerboard for blank cells helps the DRAWER tell "empty" apart from
// "painted white" while actively drawing — for a GUESSER just trying to read
// the shape, it's just visual noise behind the actual picture. `clean` (true
// for a guesser) swaps blank cells to solid white instead.
function toColor(v: number, i: number, clean: boolean): Color4 {
  if (v !== 0) return (PALETTE[v] ?? PALETTE[1]).color
  return clean ? WHITE : blankColor(Math.floor(i / GRID), i % GRID)
}

function stampIndices(i: number): number[] {
  return i >= 0 && i < GRID * GRID ? [i] : []
}

function beginStroke(): void {
  undoStack.push(grid().cells.slice())
  if (undoStack.length > 40) undoStack.shift()
  redoStack.length = 0
}
function stamp(i: number): void {
  paintCells(stampIndices(i), brush)
}
function undo(): void {
  const s = undoStack.pop()
  if (!s) return
  redoStack.push(grid().cells.slice())
  setGrid(s)
}
function redo(): void {
  const s = redoStack.pop()
  if (!s) return
  undoStack.push(grid().cells.slice())
  setGrid(s)
}
function selectBrush(k: number): void {
  brush = k
}

function cellTap(i: number): void {
  if (fillMode) {
    beginStroke()
    for (const idx of stampIndices(i)) floodFill(idx, brush)
    return
  }
  beginStroke()
  painting = true
  stamp(i)
}
function cellEnter(i: number): void {
  if (!fillMode && painting) stamp(i)
}

// ── palette / misc ────────────────────────────────────────────────────────────
const PANEL_BG = { color: Color4.create(0, 0, 0, 0.62) }
const WHITE = Color4.White()
const DIM = Color4.create(1, 1, 1, 0.7)
const GOLD = Color4.create(1, 0.85, 0.35, 1)
const GREEN = Color4.create(0.4, 0.9, 0.4, 1)
const SILVER = Color4.create(0.78, 0.8, 0.84, 1)
const BRONZE = Color4.create(0.8, 0.55, 0.32, 1)

function drawerName(): string {
  const i = roster().ids.findIndex((x) => x === state().drawerId)
  return i < 0 ? 'Someone' : roster().names[i] || 'Someone'
}
function iGuessed(): boolean {
  return roster().guessed.includes(myId())
}
function standings() {
  return roster()
    .ids.map((id, i) => ({ id, name: roster().names[i] || 'Player', score: roster().scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score)
}

const hud = () => {
  const st = state()
  // keep canvasOpen across Choosing→Drawing (word picked → canvas already opening)
  if (canvasOpen && st.phase !== Phase.Drawing && st.phase !== Phase.Choosing) canvasOpen = false
  // the local pick prediction is only ever valid for one round — clear it once
  // the real state has moved past Drawing, or if it's someone else's turn now
  if (myPickedWord !== '' && (st.phase === Phase.RoundEnd || st.phase === Phase.GameOver || st.phase === Phase.Lobby || st.drawerId !== myId())) {
    myPickedWord = ''
  }
  const overlayUp = canvasOpen && (st.phase === Phase.Drawing || myPickedWord !== '')
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}>
      {scoreboard()}
      {topBanner(st)}
      {joinButton()}
      {helpButton()}
      {centerArea(st)}
      {guessFeedPanel()}
      {showRules ? rulesPanel() : null}
      {overlayUp ? canvasOverlay(st) : null}
    </UiEntity>
  )
}

// ── Scoreboard (top-left) ──────────────────────────────────────────────────────
function scoreboard() {
  const rows = standings()
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { left: 16, top: 92 }, width: 210, flexDirection: 'column', padding: 10 }}
      uiBackground={PANEL_BG}
    >
      <Label value="SCORES" fontSize={13} color={DIM} uiTransform={{ width: '100%', height: 18 }} />
      {rows.length === 0 ? (
        <Label value="(no players yet)" fontSize={12} color={DIM} uiTransform={{ width: '100%', height: 18 }} />
      ) : (
        rows.map((r) => (
          <UiEntity key={r.id} uiTransform={{ width: '100%', height: 20, flexDirection: 'row', justifyContent: 'space-between' }}>
            <Label
              value={(r.id === state().drawerId ? '* ' : '') + r.name + (r.id === myId() ? ' (you)' : '')}
              fontSize={12}
              color={r.id === myId() ? GOLD : WHITE}
              uiTransform={{ width: 150, height: 20 }}
            />
            <Label value={`${r.score}`} fontSize={12} color={WHITE} uiTransform={{ width: 36, height: 20 }} />
          </UiEntity>
        ))
      )}
    </UiEntity>
  )
}

// ── Top banner ────────────────────────────────────────────────────────────────
function topBanner(st: ReturnType<typeof state>) {
  const text =
    st.phase === Phase.Lobby
      ? `Lobby  -  ${roster().ids.length} in${roster().ids.length < MIN_PLAYERS ? ` (need ${MIN_PLAYERS})` : ''}`
      : `Round ${st.round}/${st.totalRounds}`
  const secs = Math.ceil(remainingMs() / 1000)
  const showTimer = st.phase === Phase.Choosing || st.phase === Phase.Drawing
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { left: '50%', top: 16 }, margin: { left: -150 }, width: 300, height: 32, justifyContent: 'center', alignItems: 'center' }}
      uiBackground={PANEL_BG}
    >
      <Label value={showTimer ? `${text}   -   ${secs}s` : text} fontSize={15} color={WHITE} uiTransform={{ width: '100%', height: 32 }} />
    </UiEntity>
  )
}

// ── Join / Leave (top-right) ──────────────────────────────────────────────────
function joinButton() {
  const joined = iHaveJoined()
  const full = !joined && roster().ids.length >= MAX_PLAYERS
  if (full) {
    // Explain why there's no JOIN button rather than just not showing one —
    // still spectatable (masked word + guess feed), just not playable right now.
    return (
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { right: 16, top: 144 }, width: 180, height: 42, justifyContent: 'center', alignItems: 'center' }}
        uiBackground={{ color: Color4.create(0.25, 0.22, 0.15, 0.9) }}
      >
        <Label value={`FULL (${MAX_PLAYERS}/${MAX_PLAYERS}) — spectating`} fontSize={11} color={WHITE} uiTransform={{ width: '100%', height: '100%' }} textAlign="middle-center" />
      </UiEntity>
    )
  }
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { right: 16, top: 144 }, width: 180, height: 42 }}>
      <Button
        value={joined ? 'LEAVE GAME' : `JOIN GAME (${roster().ids.length}/${MAX_PLAYERS})`}
        fontSize={14}
        uiTransform={{ width: '100%', height: '100%' }}
        color={WHITE}
        uiBackground={{ color: joined ? Color4.create(0.5, 0.15, 0.15, 0.95) : Color4.create(0.15, 0.45, 0.2, 0.95) }}
        onMouseDown={() => {
          if (joined) {
            play('click')
            requestLeave()
          } else requestJoin() // plays its own 'join' sound
        }}
      />
    </UiEntity>
  )
}

// ── "?" help icon (top-right) + rules panel ──────────────────────────────────
function helpButton() {
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { right: 16, top: 92 }, width: 40, height: 40 }}>
      <Button
        value="?"
        fontSize={20}
        uiTransform={{ width: '100%', height: '100%' }}
        color={WHITE}
        uiBackground={{ color: showRules ? Color4.create(0.3, 0.3, 0.36, 0.95) : Color4.create(0.15, 0.4, 0.6, 0.95) }}
        onMouseDown={() => {
          play('click')
          showRules = !showRules
        }}
      />
    </UiEntity>
  )
}

const RULE_LINES = [
  'One player draws  -  everyone else guesses.',
  'The drawer picks a word, then has 75s to draw it.',
  'Guessers type their guess  -  faster correct = more points.',
  'The drawer scores when people guess it.',
  'Everyone draws once, then the highest score wins.',
  '',
  'DRAWER:  tap OPEN CANVAS      GUESSER:  tap VIEW DRAWING'
]

function rulesPanel() {
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: Color4.create(0, 0, 0, 0.7) }}
    >
      <UiEntity uiTransform={{ width: 520, flexDirection: 'column', alignItems: 'center', padding: 20 }} uiBackground={{ color: Color4.create(0.1, 0.13, 0.18, 1) }}>
        <Label value="HOW TO PLAY" fontSize={22} color={GOLD} uiTransform={{ width: '100%', height: 34 }} />
        {RULE_LINES.map((t, i) => (
          <Label
            key={i}
            value={t}
            fontSize={15}
            color={i >= 6 ? Color4.create(0.5, 0.85, 1, 1) : WHITE}
            uiTransform={{ width: 480, height: t === '' ? 10 : 26 }}
          />
        ))}
        <Button
          value="GOT IT"
          fontSize={15}
          uiTransform={{ width: 160, height: 40, margin: { top: 12 } }}
          color={WHITE}
          uiBackground={{ color: Color4.create(0.2, 0.5, 0.32, 1) }}
          onMouseDown={() => {
            play('click')
            showRules = false
          }}
        />
      </UiEntity>
    </UiEntity>
  )
}

// ── Center / bottom contextual area ──────────────────────────────────────────
function centerArea(st: ReturnType<typeof state>) {
  const box = (children: any) => (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { left: '50%', bottom: 36 }, margin: { left: -220 }, width: 440, flexDirection: 'column', alignItems: 'center', padding: 12 }}
      uiBackground={PANEL_BG}
    >
      {children}
    </UiEntity>
  )

  if (st.phase === Phase.Lobby) {
    const n = roster().ids.length
    let msg: string
    if (!iHaveJoined()) msg = 'Tap JOIN GAME to play'
    else if (n < MIN_PLAYERS) msg = `Waiting for more players…  ${n}/${MIN_PLAYERS}`
    else if (Number(st.phaseStartAt) !== 0) msg = `Starting in ${Math.ceil(remainingMs() / 1000)}s…`
    else msg = 'Starting…'
    return box(<Label value={msg} fontSize={16} color={WHITE} uiTransform={{ width: '100%', height: 26 }} />)
  }

  if (st.phase === Phase.Choosing) {
    if (iAmDrawer()) {
      return box(
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
          <Label value="Choose a word to draw:" fontSize={16} color={WHITE} uiTransform={{ width: '100%', height: 26 }} />
          <UiEntity uiTransform={{ width: '100%', height: 46, flexDirection: 'row', justifyContent: 'space-between' }}>
            {st.choices.map((w) => (
              <Button
                key={w}
                value={w.toUpperCase()}
                fontSize={14}
                uiTransform={{ width: 135, height: 42 }}
                color={WHITE}
                uiBackground={{ color: Color4.create(0.2, 0.3, 0.5, 0.95) }}
                onMouseUp={() => {
                  play('click')
                  pickWord(w)
                  myPickedWord = w // jump straight to "drawing" locally, don't wait on the sync round-trip
                  canvasOpen = true // auto-open the canvas as soon as a word is picked
                }}
              />
            ))}
          </UiEntity>
        </UiEntity>
      )
    }
    return box(<Label value={`${drawerName()} is choosing a word…`} fontSize={16} color={WHITE} uiTransform={{ width: '100%', height: 26 }} />)
  }

  if (st.phase === Phase.Drawing) {
    if (iAmDrawer()) {
      return box(
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
          <Label value={`Your word:  ${st.word.toUpperCase()}`} fontSize={16} color={GOLD} uiTransform={{ width: '100%', height: 26 }} />
          <Button
            value="OPEN CANVAS"
            fontSize={17}
            uiTransform={{ width: 240, height: 46, margin: { top: 6 } }}
            color={WHITE}
            uiBackground={{ color: Color4.create(0.2, 0.5, 0.75, 0.98) }}
            onMouseDown={() => {
              play('click')
              canvasOpen = true
            }}
          />
        </UiEntity>
      )
    }

    const viewBtn = (
      <Button
        value="VIEW DRAWING"
        fontSize={13}
        uiTransform={{ width: 180, height: 34, margin: { top: 6 } }}
        color={WHITE}
        uiBackground={{ color: Color4.create(0.2, 0.4, 0.55, 0.95) }}
        onMouseDown={() => {
          play('click')
          canvasOpen = true
        }}
      />
    )

    if (!iHaveJoined())
      return box(
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
          <Label value={`Spectating   ${maskedWord()}`} fontSize={18} color={DIM} uiTransform={{ width: '100%', height: 30 }} />
          {viewBtn}
        </UiEntity>
      )
    if (iGuessed())
      return box(
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
          <Label value={`Correct!   ${st.word.toUpperCase()}`} fontSize={18} color={GREEN} uiTransform={{ width: '100%', height: 30 }} />
          {viewBtn}
        </UiEntity>
      )

    // Typing lived here too, alongside the SAME full guess UI inside the
    // canvas overlay (VIEW DRAWING) — two different places to type the same
    // guess was unnecessary. This box now just tells you the word length and
    // sends you to VIEW DRAWING, where the dashes + input actually live.
    return box(
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
        <Label value={`${st.word.length} letters`} fontSize={18} color={WHITE} uiTransform={{ width: '100%', height: 30 }} />
        {viewBtn}
      </UiEntity>
    )
  }

  if (st.phase === Phase.RoundEnd) {
    const guessers = roster().ids.filter((id) => id !== st.drawerId)
    const allGuessed = guessers.length > 0 && guessers.every((id) => roster().guessed.includes(id))
    const rows = roster()
      .ids.map((id, i) => ({ id, name: roster().names[i] || 'Player', pts: roster().roundPoints[i] ?? 0 }))
      .sort((a, b) => b.pts - a.pts)
    return box(
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
        <Label value={`The word was:  ${st.word.toUpperCase()}`} fontSize={20} color={WHITE} uiTransform={{ width: '100%', height: 28 }} />
        <Label value={allGuessed ? 'Everyone guessed it!' : 'Time is up!'} fontSize={13} color={DIM} uiTransform={{ width: '100%', height: 20, margin: { bottom: 6 } }} />
        {rows.map((r) => (
          <UiEntity key={r.id} uiTransform={{ width: 300, height: 22, flexDirection: 'row', justifyContent: 'space-between' }}>
            <Label
              value={(r.id === st.drawerId ? '✏ ' : '') + r.name + (r.id === myId() ? '  (you)' : '')}
              fontSize={14}
              color={r.id === myId() ? GOLD : WHITE}
              uiTransform={{ width: 220, height: 22 }}
            />
            <Label value={r.pts > 0 ? `+${r.pts}` : '0'} fontSize={14} color={r.pts > 0 ? GREEN : DIM} uiTransform={{ width: 60, height: 22 }} textAlign="middle-right" />
          </UiEntity>
        ))}
      </UiEntity>
    )
  }

  const ranked = standings()
  const top = ranked[0]
  const rankColor = (i: number) => (i === 0 ? GOLD : i === 1 ? SILVER : i === 2 ? BRONZE : WHITE)
  return box(
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
      <Label value={top ? `🏆 ${top.name} is the winner!` : 'Game over'} fontSize={22} color={GOLD} uiTransform={{ width: '100%', height: 32 }} />
      {ranked.map((r, i) => (
        <UiEntity key={r.id} uiTransform={{ width: 300, height: 24, flexDirection: 'row', justifyContent: 'space-between', margin: { top: 2 } }}>
          <Label value={`#${i + 1}  ${r.name}${r.id === myId() ? '  (you)' : ''}`} fontSize={15} color={rankColor(i)} uiTransform={{ width: 220, height: 24 }} />
          <Label value={`${r.score}`} fontSize={15} color={rankColor(i)} uiTransform={{ width: 60, height: 24 }} textAlign="middle-right" />
        </UiEntity>
      ))}
      <Label value="New game starting…" fontSize={13} color={DIM} uiTransform={{ width: '100%', height: 20, margin: { top: 8 } }} />
    </UiEntity>
  )
}

// ── Guess feed (bottom-left) ─────────────────────────────────────────────────
function guessFeedPanel() {
  if (guessFeed.length === 0) return null
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { left: 16, bottom: 36 }, width: 280, flexDirection: 'column', padding: 8 }}
      uiBackground={PANEL_BG}
    >
      {guessFeed.slice(-6).map((g, i) => (
        <Label
          key={`${i}-${g.id}`}
          value={g.correct ? `${g.name} guessed it!` : `${g.name}: ${g.text}`}
          fontSize={12}
          color={g.correct ? GREEN : DIM}
          uiTransform={{ width: '100%', height: 18 }}
        />
      ))}
    </UiEntity>
  )
}

// ── Drawing canvas overlay — colours LEFT, tools RIGHT ───────────────────────
function canvasOverlay(st: ReturnType<typeof state>) {
  const ci = UiCanvasInformation.getOrNull(engine.RootEntity)
  const W = ci?.width ?? 1200
  const H = ci?.height ?? 680
  const ro = !canDraw() // guesser / spectator viewing the drawing live
  // Waiting on the pick to sync back? Show the full drawing time, not the
  // leftover choosing-phase countdown (which is still what st.phase reflects).
  const waitingOnSync = !ro && st.phase !== Phase.Drawing && myPickedWord !== ''
  const secs = waitingOnSync ? Math.ceil(DRAW_MS / 1000) : Math.ceil(remainingMs() / 1000)
  // The guesser's dash display space-separates every letter ("_ _ _ _ _ _"),
  // which is roughly TWICE as wide per letter as the drawer's own compact
  // word ("CHAIR", no gaps) — a fixed box sized for the drawer's case was too
  // narrow for longer words' dashes, causing them to overlap into what
  // looked like a solid black bar instead of visible dashes.
  const headerW = ro ? Math.max(360, st.word.length * 46) : 320
  const cells = grid().cells
  const empty = cells.every((v) => (v ?? 0) === 0)

  // Layout: colours column LEFT, tools column RIGHT, canvas in the middle. Placed
  // with flexbox (root centres everything) so it can't drift off-screen even if
  // the reported canvas size is stale — only `cell` is derived from W/H.
  const SIDE = ro ? 0 : 54 // side-column width
  const GAP = ro ? 0 : 16 // space between a column and the canvas
  const budgetW = W - (SIDE + GAP) * 2 - 48
  // Root padding (140 top + 18 bottom = 158) + the guesser's stack below the
  // canvas (margin 10 + hint 18 + input 40 + margin 6 + button 38 = 112) =
  // 270 actually needed, not 170 — the old constant never really matched
  // what's below the canvas, it was just marginal enough not to visibly
  // break until now (SUBMIT was getting clipped off the bottom).
  const budgetH = H - 290
  const cell = Math.max(12, Math.min(50, Math.floor(Math.min(budgetW, budgetH) / GRID)))
  const gp = cell * GRID
  const sw = Math.max(20, Math.min(SIDE - 8, Math.floor(gp / PALETTE.length) - 5))

  const rows = []
  for (let r = 0; r < GRID; r++) {
    const rc = []
    for (let c = 0; c < GRID; c++) {
      const i = r * GRID + c
      rc.push(
        <UiEntity
          key={i}
          uiTransform={{ width: cell, height: cell }}
          uiBackground={{ color: toColor(cells[i] ?? 0, i, ro) }}
          {...(ro ? {} : { onMouseDown: () => cellTap(i), onMouseEnter: () => cellEnter(i) })}
        />
      )
    }
    rows.push(
      <UiEntity key={`r${r}`} uiTransform={{ width: gp, height: cell, flexDirection: 'row' }}>
        {rc}
      </UiEntity>
    )
  }

  const toolBtn = (label: string, on: boolean, act: () => void) => (
    <Button
      key={label}
      value={label}
      fontSize={11}
      uiTransform={{ width: SIDE, height: 36, margin: { bottom: 5 } }}
      color={WHITE}
      uiBackground={{ color: on ? Color4.create(0.9, 0.72, 0.2, 1) : Color4.create(0.24, 0.26, 0.32, 1) }}
      onMouseDown={() => {
        play('click')
        act()
      }}
    />
  )

  const inputValue = clearFlash ? ' ' : ''
  if (clearFlash) clearFlash = false

  const paletteCol = ro ? null : (
    <UiEntity uiTransform={{ width: SIDE, flexDirection: 'column', alignItems: 'center', margin: { right: GAP } }}>
      {PALETTE.map((p, k) => (
        <UiEntity
          key={p.name}
          uiTransform={{ width: sw, height: sw, margin: { bottom: 5 }, borderWidth: brush === k ? 4 : 1, borderColor: brush === k ? GOLD : Color4.create(1, 1, 1, 0.5), borderRadius: 6 }}
          uiBackground={{ color: p.color }}
          onMouseDown={() => {
            play('click')
            selectBrush(k)
          }}
        />
      ))}
    </UiEntity>
  )

  const toolsCol = ro ? null : (
    <UiEntity uiTransform={{ width: SIDE, flexDirection: 'column', alignItems: 'center', margin: { left: GAP } }}>
      {toolBtn('UNDO', false, undo)}
      {toolBtn('REDO', false, redo)}
      {toolBtn('FILL', fillMode, () => (fillMode = !fillMode))}
      {toolBtn('PEN', !fillMode, () => (fillMode = false))}
      {toolBtn('CLEAR', false, () => {
        beginStroke()
        clearCanvas()
      })}
    </UiEntity>
  )

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: { top: 140, bottom: 18 },
        pointerFilter: 'block'
      }}
      uiBackground={{ color: Color4.create(0.36, 0.72, 0.9, 1) }}
      onMouseUp={() => (painting = false)}
    >
      {/* Dedicated, prominent timer — under the BACK/DONE button, top-right.
      Was top-center, but that overlapped the canvas on mobile. The main
      HUD's round timer (topBanner) is completely hidden once this
      full-screen overlay is up, and the small "watching · Ns left" subtitle
      next to the word wasn't prominent enough on its own. */}
      <UiEntity uiTransform={{ positionType: 'absolute', position: { right: 22, top: 138 }, width: 96, height: 34, justifyContent: 'center', alignItems: 'center' }} uiBackground={{ color: Color4.create(0, 0, 0, 0.35) }}>
        <Label value={`${secs}s`} fontSize={22} textAlign="middle-center" color={WHITE} uiTransform={{ width: '100%', height: '100%' }} />
      </UiEntity>

      {/* header — word, CENTERED, directly above the canvas (same
      horizontal center), sitting in the fixed Y:0-140 gap above it (canvas
      position/size is fixed by `padding.top:140` — not changing that).
      Tried left:16 (covered by DCL's ~490px-wide "Genesis Plaza" panel) and
      left:400 (still inside that panel on narrower mobile screens, AND
      inside the canvas's own horizontal span there). Centered is the one X
      position that's clear of a left-side panel on any screen width AND
      naturally sits directly above the (also centered) canvas. */}
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { left: '50%', top: 45 }, margin: { left: -headerW / 2 }, width: headerW, height: 70, flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start' }}
      >
        <UiEntity uiTransform={{ flexDirection: 'column', width: headerW, alignItems: 'center' }}>
          <Label value={ro ? typedDashes(st.word) : (st.word || myPickedWord).toUpperCase()} fontSize={26} textAlign="middle-center" color={Color4.Black()} uiTransform={{ width: headerW, height: 34 }} />
          {/* Revealed hints — a separate row under the dashes, purely a
          reference. Typing is always a simple 1-to-1 fill above; this never
          affects it. */}
          {ro ? (
            <Label value={hintRow(st.word, st.revealed)} fontSize={18} textAlign="middle-center" color={Color4.create(0.15, 0.35, 0.15, 1)} uiTransform={{ width: headerW, height: 24, margin: { top: 4 } }} />
          ) : null}
        </UiEntity>
      </UiEntity>

      {/* DONE/BACK — bottom of the screen, not glued to the very edge. */}
      <Button
        value={ro ? 'BACK' : 'DONE'}
        fontSize={14}
        uiTransform={{ width: 96, height: 38, positionType: 'absolute', position: { right: 22, bottom: 90 } }}
        color={WHITE}
        uiBackground={{ color: Color4.create(0.12, 0.14, 0.18, 1) }}
        onMouseDown={() => {
          play('click')
          painting = false
          canvasOpen = false
          }}
        />

      {/* main row: palette | canvas | tools */}
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
        {paletteCol}

        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
          <UiEntity
            uiTransform={{ width: gp, height: gp, flexDirection: 'column' }}
            uiBackground={{ color: Color4.White() }}
            {...(ro ? {} : { onMouseLeave: () => (painting = false) })}
          >
            {rows}
            {empty && !ro ? (
              <UiEntity uiTransform={{ positionType: 'absolute', position: { top: '44%', left: 0 }, width: '100%', justifyContent: 'center' }}>
                <Label value="Tap a pixel to draw" fontSize={15} color={Color4.create(0.36, 0.62, 0.86, 1)} />
              </UiEntity>
            ) : null}
          </UiEntity>

          {/* guesser: type the word right here */}
          {ro && !iGuessed() ? (
            <UiEntity uiTransform={{ width: gp, flexDirection: 'column', alignItems: 'center', margin: { top: 10 } }}>
              <Label value="👆 tap the box, type your guess, then tap SUBMIT" fontSize={13} color={GOLD} uiTransform={{ width: gp, height: 18 }} textAlign="middle-left" />
              <Input
                placeholder="tap here…"
                // Only pass `value` during the one-frame clear pulse right
                // after a submit (inputValue is ' ' that one frame, '' every
                // other frame — `clearFlash` itself is already reset to
                // false by the time we get here, see above) — the Input is
                // uncontrolled per the SDK (see build-ui skill), and passing
                // `value=''` on every OTHER frame too can fight what's
                // actually been typed on some platforms, making it look
                // like nothing shows up while typing even though `typed` is
                // tracking it correctly.
                {...(inputValue ? { value: inputValue } : {})}
                fontSize={15}
                // Text color matches the background — see the note on the
                // other guess Input for why (the dash display above is now
                // the real feedback).
                color={Color4.create(0.22, 0.26, 0.34, 1)}
                uiTransform={{ width: gp, height: 40, borderWidth: 2, borderColor: GOLD, borderRadius: 6 }}
                uiBackground={{ color: Color4.create(0.22, 0.26, 0.34, 1) }}
                onChange={(v) => (typed = v)}
                onSubmit={(v) => {
                  submitGuess(v || typed)
                  typed = ''
                  clearFlash = true
                }}
              />
              <Button
                value="SUBMIT"
                fontSize={13}
                uiTransform={{ width: gp, height: 38, margin: { top: 6 } }}
                color={WHITE}
                uiBackground={{ color: Color4.create(0.2, 0.5, 0.32, 1) }}
                onMouseDown={() => {
                  play('click')
                  submitGuess(typed)
                  typed = ''
                  clearFlash = true
                }}
              />
            </UiEntity>
          ) : null}
          {ro && iGuessed() ? (
            <Label value={`✓ you guessed it — ${st.word.toUpperCase()}`} fontSize={16} color={GREEN} uiTransform={{ width: gp, height: 28, margin: { top: 10 } }} />
          ) : null}
        </UiEntity>

        {toolsCol}
      </UiEntity>
    </UiEntity>
  )
}
