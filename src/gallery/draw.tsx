/**
 * Single-player DRAW mode: pick 1 of 3 words, draw it on a 16x16 canvas against
 * a timer, and it's submitted to the gallery with that word as the answer. It
 * then shows up as one of the 12 canvases in GUESS mode for everyone.
 */

import ReactEcs, { UiEntity, Label, Button } from '@dcl/sdk/react-ecs'
import { engine, UiCanvasInformation, executeTask } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { PALETTE, blankColor, GRID, CELL_COUNT, WORDS } from '../game/state'
import { BACKEND, fetchGallery, normalizeWord } from './atlas'
import { getScreen, Screen, goMenu } from '../app'
import { play } from '../sound'

const DRAW_MS = 90_000

const cells: number[] = new Array(CELL_COUNT).fill(0)
let brush = 1
let painting = false
let fillMode = false
const undoStack: number[][] = []
const redoStack: number[][] = []

// The UI render function re-runs every frame — react-ecs has no hooks/memo,
// so without this the 256-cell grid below gets rebuilt from scratch (256
// fresh UiEntity JSX objects) on EVERY frame for the full up-to-90s drawing
// phase, not just when a pixel actually changes. Fine on desktop; a likely
// real cause of a reported mobile-only freeze right after a DRAW round (GC
// pressure from ~700k+ allocations over one round, compounding with GUESS
// mode's own setup cost the moment you land there). `cellsVersion` bumps
// only on an actual paint mutation; canvasScreen() reuses the cached JSX
// array whenever nothing has changed since the last frame.
let cellsVersion = 0
let cachedRows: unknown[] | null = null
let cachedRowsKey = ''

type Phase = 'choosing' | 'drawing' | 'timeup' | 'done'
let phase: Phase = 'choosing'
let choices: string[] = []
let chosen = ''
let drawStartAt = 0
let status: 'idle' | 'sending' | 'error' = 'idle'
let statusMsg = ''

const WHITE = Color4.White()
const GOLD = Color4.create(1, 0.85, 0.35, 1)

// ── round flow ─────────────────────────────────────────────────────────────────

export function setupDraw(): void {
  engine.addSystem(drawSystem)
}

export function startDrawRound(): void {
  phase = 'choosing'
  chosen = ''
  status = 'idle'
  statusMsg = ''
  for (let i = 0; i < CELL_COUNT; i++) cells[i] = 0
  cellsVersion++
  undoStack.length = 0
  redoStack.length = 0
  fillMode = false
  // Pick the 3 choices exactly ONCE, after we know what's already in the
  // gallery (best-effort) — showing a fallback set immediately and then
  // silently swapping them a second later (once the fetch landed) read as a
  // bug: the words you were looking at changed out from under you. `choices`
  // starts empty so chooser() can show a brief loading state instead.
  choices = []
  executeTask(async () => {
    let taken = new Set<string>()
    try {
      const g = await fetchGallery()
      taken = new Set(g.tiles.map((t) => normalizeWord(t.word)))
    } catch {
      /* no exclusions if the fetch fails — still pick something */
    }
    if (phase === 'choosing' && choices.length === 0) choices = pickThree(taken)
  })
}

function pickThree(exclude: Set<string>): string[] {
  const pool = WORDS.filter((w) => !exclude.has(normalizeWord(w)))
  const src = pool.length >= 3 ? pool : WORDS.slice()
  const out: string[] = []
  const used = new Set<number>()
  while (out.length < 3 && used.size < src.length) {
    const k = Math.floor(Math.random() * src.length)
    if (used.has(k)) continue
    used.add(k)
    out.push(src[k])
  }
  return out
}

function chooseWord(w: string): void {
  play('click')
  chosen = w
  phase = 'drawing'
  drawStartAt = Date.now()
}

function remainingMs(): number {
  return Math.max(0, DRAW_MS - (Date.now() - drawStartAt))
}

function drawSystem(): void {
  if (getScreen() !== Screen.Draw || phase !== 'drawing') return
  // Time's up just freezes the canvas — the player still chooses submit or discard.
  if (remainingMs() === 0) {
    phase = 'timeup'
    play('timesUp')
    return
  }
}

function discard(): void {
  play('discard')
  startDrawRound()
}

function submit(): void {
  if (status === 'sending') return
  if (cells.every((v) => v === 0)) {
    status = 'error'
    statusMsg = 'draw something first'
    return
  }
  status = 'sending'
  statusMsg = 'sending…'
  executeTask(async () => {
    try {
      const res = await fetch(`${BACKEND}/painting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: chosen, cells, author: getPlayer()?.name || 'anon' })
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (data.ok) {
        play('youGotIt') // "submitted" stand-in
        phase = 'done'
        status = 'idle'
      } else {
        status = 'error'
        statusMsg = data.error || 'rejected'
      }
    } catch (e) {
      status = 'error'
      statusMsg = 'network error'
      console.log('[draw] submit failed:', String(e))
    }
  })
}

// ── paint ──────────────────────────────────────────────────────────────────────

function cellColor(i: number): Color4 {
  const v = cells[i] ?? 0
  return v === 0 ? blankColor(Math.floor(i / GRID), i % GRID) : (PALETTE[v] ?? PALETTE[1]).color
}

function paint(i: number): void {
  if (phase === 'drawing' && cells[i] !== brush) {
    cells[i] = brush
    cellsVersion++
  }
}

function beginStroke(): void {
  undoStack.push(cells.slice())
  if (undoStack.length > 40) undoStack.shift()
  redoStack.length = 0
}

function restoreSnapshot(s: number[]): void {
  for (let i = 0; i < CELL_COUNT; i++) cells[i] = s[i] ?? 0
  cellsVersion++
}

function undo(): void {
  const s = undoStack.pop()
  if (!s) return
  redoStack.push(cells.slice())
  restoreSnapshot(s)
}

function redo(): void {
  const s = redoStack.pop()
  if (!s) return
  undoStack.push(cells.slice())
  restoreSnapshot(s)
}

/** Bucket fill from `index`, local to this drawing (no server round-trip). */
function floodFill(index: number): void {
  const target = cells[index] ?? 0
  if (target === brush) return
  const stack = [index]
  while (stack.length) {
    const i = stack.pop() as number
    if ((cells[i] ?? 0) !== target) continue
    cells[i] = brush
    const r = Math.floor(i / GRID)
    const c = i % GRID
    if (c > 0) stack.push(i - 1)
    if (c < GRID - 1) stack.push(i + 1)
    if (r > 0) stack.push(i - GRID)
    if (r < GRID - 1) stack.push(i + GRID)
  }
  cellsVersion++
}

function cellTap(i: number): void {
  if (phase !== 'drawing') return
  beginStroke()
  if (fillMode) {
    floodFill(i)
    return
  }
  painting = true
  paint(i)
}

function cellEnter(i: number): void {
  if (phase === 'drawing' && !fillMode && painting) paint(i)
}

function clearAll(): void {
  beginStroke()
  for (let i = 0; i < CELL_COUNT; i++) cells[i] = 0
  cellsVersion++
}

// ── HUD ────────────────────────────────────────────────────────────────────────

export function drawHud() {
  if (phase === 'choosing') return chooser()
  if (phase === 'done') return doneScreen()
  return canvasScreen(phase === 'timeup')
}

function toolBtn(label: string, on: boolean, act: () => void) {
  return (
    <Button
      key={label}
      value={label}
      fontSize={11}
      uiTransform={{ width: 72, height: 34, margin: { left: 3, right: 3 } }}
      color={WHITE}
      uiBackground={{ color: on ? Color4.create(0.9, 0.72, 0.2, 1) : Color4.create(0.24, 0.26, 0.32, 1) }}
      onMouseDown={() => {
        play('click')
        act()
      }}
    />
  )
}

function menuBtn() {
  return (
    // top:92, not 14: DCL's own top-left chrome (profile icon, nearby-players
    // panel) occupies that band and covers anything rendered there (same
    // issue already fixed for the multiplayer HUD and GUESS mode's MENU).
    <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 16, top: 92 }, width: 88, height: 32 }}>
      <Button value="MENU" fontSize={12} uiTransform={{ width: '100%', height: '100%' }} color={WHITE} uiBackground={{ color: Color4.create(0.12, 0.14, 0.18, 1) }} onMouseUp={() => { play('click'); goMenu() }} />
    </UiEntity>
  )
}

function chooser() {
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' }}
      uiBackground={{ color: Color4.create(0.07, 0.09, 0.13, 1) }}
    >
      {menuBtn()}
      <UiEntity uiTransform={{ width: 420, flexDirection: 'column', alignItems: 'center', padding: 24, pointerFilter: 'block' }} uiBackground={{ color: Color4.create(0.12, 0.15, 0.2, 1) }}>
        <Label value="PICK A WORD TO DRAW" fontSize={20} color={GOLD} uiTransform={{ width: '100%', height: 34 }} />
        <Label value={`then you have ${Math.round(DRAW_MS / 1000)}s to draw it`} fontSize={13} color={Color4.create(1, 1, 1, 0.7)} uiTransform={{ width: '100%', height: 22, margin: { bottom: 6 } }} />
        {choices.length === 0 ? (
          <Label value="picking words…" fontSize={14} color={Color4.create(1, 1, 1, 0.6)} uiTransform={{ width: '100%', height: 48, margin: { top: 8 } }} />
        ) : (
          choices.map((w) => (
            <Button
              key={w}
              value={w.toUpperCase()}
              fontSize={16}
              uiTransform={{ width: 300, height: 48, margin: { top: 8 } }}
              color={WHITE}
              uiBackground={{ color: Color4.create(0.2, 0.4, 0.62, 1) }}
              onMouseUp={() => chooseWord(w)}
            />
          ))
        )}
      </UiEntity>
    </UiEntity>
  )
}

function canvasScreen(frozen: boolean) {
  const ci = UiCanvasInformation.getOrNull(engine.RootEntity)
  const W = ci?.width ?? 1200
  const H = ci?.height ?? 680
  const cell = Math.max(12, Math.min(30, Math.floor(Math.min(W - 60, H - 275) / GRID)))
  const gp = cell * GRID
  const secs = Math.ceil(remainingMs() / 1000)
  const blank = cells.every((v) => v === 0)

  const rowsKey = `${cellsVersion}|${cell}|${frozen}`
  let rows: unknown[]
  if (cachedRows && cachedRowsKey === rowsKey) {
    rows = cachedRows
  } else {
    rows = []
    for (let r = 0; r < GRID; r++) {
      const rc = []
      for (let c = 0; c < GRID; c++) {
        const i = r * GRID + c
        rc.push(
          <UiEntity
            key={i}
            uiTransform={{ width: cell, height: cell }}
            uiBackground={{ color: cellColor(i) }}
            {...(frozen ? {} : { onMouseDown: () => cellTap(i), onMouseEnter: () => cellEnter(i) })}
          />
        )
      }
      rows.push(
        <UiEntity key={`r${r}`} uiTransform={{ width: gp, height: cell, flexDirection: 'row' }}>
          {rc}
        </UiEntity>
      )
    }
    cachedRows = rows
    cachedRowsKey = rowsKey
  }

  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', width: '100%', height: '100%', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: { top: 52, bottom: 14 } }}
      uiBackground={{ color: Color4.create(0.36, 0.72, 0.9, 1) }}
    >
      {/* Every blocking region below is scoped to just the interactive
      content (header bar, palette, toolbar, the grid itself) instead of one
      full-screen `pointerFilter:'block'` wrapper. A full-screen blocker here
      was the suspected cause of a mobile-only bug: after leaving DRAW mode,
      a box-shaped dead zone (matching roughly where this canvas sat)
      persisted in GUESS mode — camera-drag/joystick did nothing inside that
      region, worked fine at the screen edges. Smaller, separate blocking
      rects reduce what there is to leak, and this also matches DCL's own
      guidance: never put a pointer handler/`block` on a full-screen wrapper,
      scope it to what actually needs it. */}
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { left: 0, top: 10 }, width: '100%', height: 36, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: { left: 14, right: 18 }, pointerFilter: 'block' }}
      >
        <Button value="← BACK" fontSize={12} uiTransform={{ width: 88, height: 32 }} color={WHITE} uiBackground={{ color: Color4.create(0.12, 0.14, 0.18, 1) }} onMouseUp={() => { play('click'); startDrawRound() }} />
        <Label value={`DRAW:  ${chosen.toUpperCase()}`} fontSize={16} textAlign="middle-center" color={Color4.create(0.1, 0.12, 0.16, 1)} uiTransform={{ width: 240, height: 30 }} />
        <Label
          value={frozen ? "TIME'S UP" : `${secs}s`}
          fontSize={frozen ? 13 : 17}
          textAlign="middle-right"
          color={frozen || secs <= 15 ? Color4.create(0.7, 0.1, 0.1, 1) : Color4.create(0.1, 0.12, 0.16, 1)}
          uiTransform={{ width: 78, height: 30 }}
        />
      </UiEntity>

      {frozen ? null : (
        <UiEntity uiTransform={{ width: gp, flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', margin: { bottom: 6 }, pointerFilter: 'block' }}>
          {PALETTE.map((p, k) => (
            <UiEntity
              key={p.name}
              uiTransform={{ width: 26, height: 26, margin: { left: 2, right: 2 }, borderWidth: brush === k ? 4 : 1, borderColor: brush === k ? GOLD : Color4.create(1, 1, 1, 0.4), borderRadius: 4 }}
              uiBackground={{ color: p.color }}
              onMouseDown={() => {
                play('click')
                brush = k
              }}
            />
          ))}
        </UiEntity>
      )}

      {frozen ? null : (
        <UiEntity uiTransform={{ width: gp, flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', margin: { bottom: 8 }, pointerFilter: 'block' }}>
          {toolBtn('UNDO', false, undo)}
          {toolBtn('REDO', false, redo)}
          {toolBtn(fillMode ? 'FILL' : 'PEN', fillMode, () => (fillMode = !fillMode))}
        </UiEntity>
      )}

      <UiEntity uiTransform={{ width: gp, height: gp, flexDirection: 'column', pointerFilter: 'block' }} uiBackground={{ color: Color4.White() }} onMouseUp={() => (painting = false)}>
        {rows}
      </UiEntity>

      {frozen ? (
        <UiEntity uiTransform={{ width: gp, flexDirection: 'column', alignItems: 'center', margin: { top: 10 }, pointerFilter: 'block' }}>
          <Label value="time ran out — keep it or bin it?" fontSize={13} color={Color4.create(0.1, 0.14, 0.2, 1)} uiTransform={{ width: gp, height: 20 }} />
          <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 6 } }}>
            <Button value="🗑 DISCARD" fontSize={13} uiTransform={{ width: 130, height: 42, margin: { right: 6 } }} color={WHITE} uiBackground={{ color: Color4.create(0.55, 0.2, 0.2, 1) }} onMouseUp={discard} />
            {!blank ? (
              <Button
                value={status === 'sending' ? 'SENDING…' : 'SUBMIT'}
                fontSize={14}
                uiTransform={{ width: 160, height: 42, margin: { left: 6 } }}
                color={WHITE}
                uiBackground={{ color: Color4.create(0.2, 0.5, 0.75, 0.98) }}
                onMouseUp={submit}
              />
            ) : null}
          </UiEntity>
        </UiEntity>
      ) : (
        <UiEntity uiTransform={{ width: gp, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', margin: { top: 10 }, pointerFilter: 'block' }}>
          <Button value="CLEAR" fontSize={12} uiTransform={{ width: 100, height: 40, margin: { right: 8 } }} color={WHITE} uiBackground={{ color: Color4.create(0.24, 0.26, 0.32, 1) }} onMouseDown={() => { play('click'); clearAll() }} />
          <Button
            value={status === 'sending' ? 'SENDING…' : 'SUBMIT'}
            fontSize={14}
            uiTransform={{ width: 200, height: 42 }}
            color={WHITE}
            uiBackground={{ color: Color4.create(0.2, 0.5, 0.75, 0.98) }}
            onMouseUp={submit}
          />
        </UiEntity>
      )}
      {status === 'error' ? <Label value={statusMsg} fontSize={13} color={Color4.create(0.55, 0.05, 0.05, 1)} uiTransform={{ width: gp, height: 20, margin: { top: 4 } }} /> : null}
    </UiEntity>
  )
}

function doneScreen() {
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' }}
      uiBackground={{ color: Color4.create(0, 0, 0, 0.75) }}
    >
      <UiEntity uiTransform={{ width: 380, flexDirection: 'column', alignItems: 'center', padding: 24, pointerFilter: 'block' }} uiBackground={{ color: Color4.create(0.12, 0.15, 0.2, 1) }}>
        <Label value="✓ ADDED TO THE GALLERY" fontSize={18} color={Color4.create(0.4, 0.9, 0.45, 1)} uiTransform={{ width: '100%', height: 30 }} />
        <Label value={`"${chosen.toUpperCase()}" is now on the wall`} fontSize={14} color={WHITE} uiTransform={{ width: '100%', height: 24, margin: { bottom: 8 } }} />
        <UiEntity uiTransform={{ flexDirection: 'row' }}>
          {/* onMouseUp, not onMouseDown: this button's tap removes the last
          full-screen `pointerFilter:'block'` layer of the DRAW flow. Doing
          that on mouseDOWN swaps the tree away mid-touch, before the
          matching touch-up is ever delivered to a (now-gone) element — a
          documented DCL pointer-capture gotcha (see build-ui skill) that can
          leave the explorer thinking a touch is still active, freezing
          movement on the next screen. onMouseUp lets the tap fully land on
          this still-mounted button first. */}
          <Button value="DRAW ANOTHER" fontSize={13} uiTransform={{ width: 150, height: 40, margin: { right: 6 } }} color={WHITE} uiBackground={{ color: Color4.create(0.2, 0.5, 0.32, 1) }} onMouseUp={() => { play('click'); startDrawRound() }} />
          <Button value="MENU" fontSize={13} uiTransform={{ width: 100, height: 40, margin: { left: 6 } }} color={WHITE} uiBackground={{ color: Color4.create(0.25, 0.27, 0.32, 1) }} onMouseUp={() => { play('click'); goMenu() }} />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
