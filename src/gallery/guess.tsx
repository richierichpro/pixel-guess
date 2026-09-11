/**
 * Single-player GUESS mode: 12 easels spread across the parcel, each showing one
 * of the 12 most-recent paintings. Walk up to a canvas, type what it is. Faster =
 * you clear more before the 2-minute clock runs out. Score goes to the leaderboard.
 */

import ReactEcs, { UiEntity, Label, Button, Input } from '@dcl/sdk/react-ecs'
import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  TextShape,
  Font,
  TextAlignMode,
  VisibilityComponent,
  executeTask,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { BACKEND, SLOTS, fetchGallery, applyTile, blankCanvas, normalizeWord } from './atlas'
import { getScreen, Screen, goMenu } from '../app'
import { PALETTE, GRID } from '../game/state'
import { play } from '../sound'

const ROUND_MS = 180_000 // 3 min — the arena is 48x48m
const REACH = 4.5 // metres to activate a canvas

interface Easel {
  frame: Entity
  front: Entity
  back: Entity
  label: Entity
  x: number
  z: number
}

// Spread across the 48x48m arena — a proper walk between each.
const GRID_X = [6, 18, 30, 42]
const GRID_Z = [8, 24, 40]

const easels: Easel[] = []
const words: Array<string | null> = new Array(SLOTS).fill(null)
const cellsOf: Array<number[] | null> = new Array(SLOTS).fill(null)
const solved: boolean[] = new Array(SLOTS).fill(false)

let built = false
let arenaRoot: Entity
let arenaShown = false
let startAt = 0
let finished = false
let activeIdx = -1
let guessOpen = false // the type-a-guess box is only up when the player opens it
let guessFor = -1 // which easel the open box is for
let typed = ''
let clearFlash = false
let feedback = ''

let cachedGuessRows: unknown[] | null = null
let cachedGuessRowsFor = -2 // never equals a real guessFor (-1) or index on first render

let leaderboard: Array<{ name: string; correct: number; userId?: string }> = []
let submitted = false
// cached once per round from a single getPlayer() call — results() re-renders
// every frame while shown, and repeated getPlayer() calls are unnecessary
// round-trips into the SDK's identity RPC (flaky on mobile connections)
let myName = ''
let myUserId = ''

const WHITE = Color4.White()
const GOLD = Color4.create(1, 0.85, 0.35, 1)
const GREEN = Color4.create(0.4, 0.9, 0.45, 1)
const PANEL = { color: Color4.create(0, 0, 0, 0.68) }

// ── world ──────────────────────────────────────────────────────────────────────

export function setupGuess(): void {
  if (built) return
  built = true

  const root = engine.addEntity()
  Transform.create(root, { position: Vector3.create(0, 0, 0) })
  // The 12-easel arena is built once and reused across rounds, but it must
  // not stay visible outside GUESS mode — same issue the multiplayer board
  // had (see board.ts): built once, never hidden, so it sat there overlapping
  // OTHER modes' geometry ("empty canvas in the guessing game" was the board
  // showing through; the reverse — this arena showing through in Multiplayer
  // — was never fixed since it never had a reason to surface until now).
  // propagateToChildren hides all ~60 child entities with one component write.
  VisibilityComponent.create(root, { visible: false, propagateToChildren: true })
  arenaRoot = root

  let i = 0
  for (const z of GRID_Z) {
    for (const x of GRID_X) {
      // Frame is centred at y=1.85 with height 2.05, so its bottom edge sits at
      // y=0.825 — keep the stand's top under that so it doesn't poke through the canvas.
      const stand = engine.addEntity()
      Transform.create(stand, { parent: root, position: Vector3.create(x, 0.4, z), scale: Vector3.create(0.14, 0.8, 0.14) })
      MeshRenderer.setBox(stand)
      Material.setBasicMaterial(stand, { diffuseColor: Color4.create(0.28, 0.22, 0.16, 1), castShadows: false })

      const frame = engine.addEntity()
      Transform.create(frame, { parent: root, position: Vector3.create(x, 1.85, z), scale: Vector3.create(2.05, 2.05, 0.08) })
      MeshRenderer.setBox(frame)
      Material.setBasicMaterial(frame, { diffuseColor: Color4.create(0.1, 0.1, 0.13, 1), castShadows: false })

      const front = engine.addEntity()
      Transform.create(front, { parent: root, position: Vector3.create(x, 1.85, z + 0.05), scale: Vector3.create(1.8, 1.8, 1) })
      MeshRenderer.setPlane(front)
      blankCanvas(front)

      const back = engine.addEntity()
      Transform.create(back, {
        parent: root,
        position: Vector3.create(x, 1.85, z - 0.05),
        scale: Vector3.create(1.8, 1.8, 1),
        rotation: Quaternion.fromEulerDegrees(0, 180, 0)
      })
      MeshRenderer.setPlane(back)
      blankCanvas(back)

      const label = engine.addEntity()
      Transform.create(label, { parent: root, position: Vector3.create(x, 0.62, z) })
      TextShape.create(label, {
        text: `#${i + 1}`,
        fontSize: 1,
        font: Font.F_SANS_SERIF,
        textColor: WHITE,
        outlineColor: Color3.create(0, 0, 0),
        outlineWidth: 0.25,
        textAlign: TextAlignMode.TAM_MIDDLE_CENTER
      })

      easels.push({ frame, front, back, label, x, z })
      i++
    }
  }

  engine.addSystem(guessSystem)
}

export function startGuessRound(): void {
  startAt = Date.now()
  finished = false
  submitted = false
  activeIdx = -1
  guessOpen = false
  guessFor = -1
  feedback = ''
  leaderboard = []
  solved.fill(false)
  for (const e of easels) Material.setBasicMaterial(e.frame, { diffuseColor: Color4.create(0.1, 0.1, 0.13, 1), castShadows: false })
  loadGallery()
}

function loadGallery(): void {
  executeTask(async () => {
    try {
      const g = await fetchGallery()
      for (let i = 0; i < SLOTS; i++) {
        const t = g.tiles[i]
        words[i] = t ? normalizeWord(t.word) : null
        cellsOf[i] = t ? t.cells : null
        if (t) {
          applyTile(easels[i].front, g.atlasUrls, i)
          applyTile(easels[i].back, g.atlasUrls, i)
        } else {
          blankCanvas(easels[i].front)
          blankCanvas(easels[i].back)
        }
        setLabel(i)
      }
      console.log(`[guess] ${g.tiles.length} paintings loaded`)
    } catch (e) {
      console.log('[guess] gallery fetch failed:', String(e))
    }
  })
}

function setLabel(i: number): void {
  const w = words[i]
  const t = TextShape.getMutable(easels[i].label)
  if (w === null) {
    t.text = '—'
    t.fontSize = 1
    t.textColor = WHITE
  } else if (solved[i]) {
    t.text = w.toUpperCase()
    t.fontSize = 1
    t.textColor = GREEN
  } else if (i === activeIdx) {
    // skribbl-style dashes, one per letter, shown when you're standing at the canvas
    t.text = w.split('').map(() => '_').join(' ')
    t.fontSize = 1.5
    t.textColor = GOLD
  } else {
    // visible from a distance so you can judge a canvas before walking over —
    // no canvas numbers, just how many letters the word is
    t.text = `${w.length} letters`
    t.fontSize = 1
    t.textColor = WHITE
  }
}

function remainingMs(): number {
  return Math.max(0, ROUND_MS - (Date.now() - startAt))
}

function activeCount(): number {
  return words.filter((w) => w !== null).length
}

function solvedCount(): number {
  return solved.filter(Boolean).length
}

function finishRound(reason: 'timeout' | 'complete'): void {
  if (finished) return
  finished = true
  play(reason === 'timeout' ? 'timesUp' : 'gameOver') // gameOver = victory stand-in
  const prev = activeIdx
  activeIdx = -1
  if (prev >= 0) setLabel(prev)
  closeGuess()
  submitScore() // auto-post to the leaderboard under the player's real identity
}

function guessSystem(): void {
  const inGuess = getScreen() === Screen.Guess
  if (inGuess !== arenaShown) {
    arenaShown = inGuess
    VisibilityComponent.getMutable(arenaRoot).visible = inGuess
  }
  if (!inGuess || finished) return
  if (remainingMs() === 0) {
    finishRound('timeout')
    return
  }
  if (!Transform.has(engine.PlayerEntity)) return
  const p = Transform.get(engine.PlayerEntity).position
  let best = -1
  let bestD = REACH * REACH
  // Find the geometrically NEAREST easel, full stop — never skip past it to a
  // farther one just because its painting hasn't loaded. Silently substituting
  // a different easel is how "the wrong canvas opens" happens: you're standing
  // at #5, it has no data yet, so #5 gets skipped and #7 (farther away) wins
  // instead — you tap GUESS thinking you're answering for #5 and get #7.
  for (let i = 0; i < SLOTS; i++) {
    if (solved[i]) continue
    const dx = p.x - easels[i].x
    const dz = p.z - easels[i].z
    const d = dx * dx + dz * dz
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  if (best !== activeIdx) {
    const prev = activeIdx
    activeIdx = best
    if (prev >= 0) setLabel(prev) // revert the one we left
    if (best >= 0) setLabel(best) // show dashes on the one we reached
  }
  // walked away from (or solved) the canvas the guess box was open for -> close it
  if (guessOpen && activeIdx !== guessFor) closeGuess()
}

function openGuess(): void {
  if (activeIdx < 0 || words[activeIdx] === null) return // nothing loaded there yet
  play('click')
  guessOpen = true
  guessFor = activeIdx
  feedback = ''
  typed = ''
  clearFlash = true
}

function closeGuess(): void {
  guessOpen = false
  guessFor = -1
  feedback = ''
}

function tryGuess(text: string): void {
  if (finished || guessFor < 0) return
  const g = normalizeWord(text)
  if (!g) return
  if (g === words[guessFor]) {
    play('correct')
    solved[guessFor] = true
    setLabel(guessFor)
    Material.setBasicMaterial(easels[guessFor].frame, { diffuseColor: Color4.create(0.15, 0.5, 0.2, 1), castShadows: false })
    closeGuess()
    activeIdx = -1
    if (solvedCount() === activeCount()) finishRound('complete')
  } else {
    play('wrong')
    feedback = 'not quite — try again'
    typed = ''
    clearFlash = true
  }
}

function submitScore(): void {
  if (submitted) return
  submitted = true
  const me = getPlayer()
  myName = me?.name || 'Guest' // cached for results() — no per-frame getPlayer() calls
  myUserId = me?.userId || ''
  executeTask(async () => {
    try {
      await fetch(`${BACKEND}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: myName,
          userId: myUserId,
          correct: solvedCount(),
          total: activeCount()
        })
      })
      const r = await fetch(`${BACKEND}/leaderboard`)
      leaderboard = (await r.json()) as Array<{ name: string; correct: number; userId?: string }>
    } catch (e) {
      console.log('[guess] score submit failed:', String(e))
    }
  })
}

// ── HUD ────────────────────────────────────────────────────────────────────────

export function guessHud() {
  const inputValue = clearFlash ? ' ' : ''
  if (clearFlash) clearFlash = false

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}>
      {/* timer + progress */}
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { left: '50%', top: 16 }, margin: { left: -110 }, width: 220, height: 34, justifyContent: 'center', alignItems: 'center' }}
        uiBackground={PANEL}
      >
        <Label value={`${clock(remainingMs())}    ${solvedCount()} / ${activeCount()}`} fontSize={16} color={WHITE} uiTransform={{ width: '100%', height: 34 }} />
      </UiEntity>

      {/* menu button — top:92, not 16: DCL's own top-left chrome (profile icon,
      nearby-players panel) occupies that exact band and covers anything we
      render there (same issue already fixed for the multiplayer HUD). */}
      <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 16, top: 92 }, width: 90, height: 34 }}>
        {/* onMouseUp: see the CLOSE/SUBMIT/results buttons below for why —
        this removes/swaps a full-screen tree and mouseDOWN would do that
        mid-touch. */}
        <Button value="MENU" fontSize={12} uiTransform={{ width: '100%', height: '100%' }} color={WHITE} uiBackground={{ color: Color4.create(0.2, 0.22, 0.28, 0.95) }} onMouseUp={() => { play('click'); goMenu() }} />
      </UiEntity>

      {!finished && !guessOpen ? prompt() : null}
      {!finished && guessOpen ? guessBox(inputValue) : null}
      {finished ? results() : null}
    </UiEntity>
  )
}

/** Small non-blocking prompt at the bottom — never captures the keyboard. */
function prompt() {
  if (activeIdx < 0) {
    return (
      <UiEntity uiTransform={{ positionType: 'absolute', position: { left: '50%', bottom: 44 }, margin: { left: -140 }, width: 280, height: 30, justifyContent: 'center', alignItems: 'center' }} uiBackground={PANEL}>
        <Label value="walk up to a canvas" fontSize={13} color={Color4.create(1, 1, 1, 0.65)} uiTransform={{ width: '100%', height: 24 }} />
      </UiEntity>
    )
  }
  if (words[activeIdx] === null) {
    return (
      <UiEntity uiTransform={{ positionType: 'absolute', position: { left: '50%', bottom: 44 }, margin: { left: -140 }, width: 280, height: 30, justifyContent: 'center', alignItems: 'center' }} uiBackground={PANEL}>
        <Label value="nothing here yet" fontSize={13} color={Color4.create(1, 1, 1, 0.65)} uiTransform={{ width: '100%', height: 24 }} />
      </UiEntity>
    )
  }
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { left: '50%', bottom: 40 }, margin: { left: -170 }, width: 340, height: 56, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', padding: 8 }} uiBackground={PANEL}>
      <Label value={`${(words[activeIdx] ?? '').length} letters`} fontSize={13} color={GOLD} uiTransform={{ width: 190, height: 24 }} />
      <Button value="VIEW" fontSize={14} uiTransform={{ width: 110, height: 40 }} color={WHITE} uiBackground={{ color: Color4.create(0.2, 0.5, 0.75, 1) }} onMouseDown={openGuess} />
    </UiEntity>
  )
}

/** A crisp close-up (flat-colored UI squares — never blurry, unlike the world
 * texture) plus the letter dashes and the guess box. Deliberately opened by the
 * player, so it's fine for the Input to hold the keyboard here. */
function guessBox(inputValue: string) {
  const cells = cellsOf[guessFor]
  const word = words[guessFor] ?? ''
  const cell = 16
  const gp = cell * GRID

  // This grid is READ-ONLY and never changes while the box stays open — but
  // the UI render function reruns every frame regardless, so without this
  // cache it was rebuilding 256 fresh UiEntity objects every single frame
  // purely to redraw the exact same pixels, for as long as someone sits here
  // typing a guess. Cache by `guessFor`: only rebuild when a DIFFERENT
  // canvas's box opens.
  let rows: unknown[]
  if (cachedGuessRows && cachedGuessRowsFor === guessFor) {
    rows = cachedGuessRows
  } else {
    rows = []
    if (cells) {
      for (let r = 0; r < GRID; r++) {
        const rc = []
        for (let c = 0; c < GRID; c++) {
          const i = r * GRID + c
          const v = cells[i] ?? 0
          rc.push(
            <UiEntity
              key={i}
              uiTransform={{ width: cell, height: cell }}
              uiBackground={{ color: v === 0 ? WHITE : (PALETTE[v] ?? PALETTE[1]).color }}
            />
          )
        }
        rows.push(
          <UiEntity key={`r${r}`} uiTransform={{ width: gp, height: cell, flexDirection: 'row' }}>
            {rc}
          </UiEntity>
        )
      }
    }
    cachedGuessRows = rows
    cachedGuessRowsFor = guessFor
  }

  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: Color4.create(0, 0, 0, 0.7) }}
    >
      <UiEntity uiTransform={{ width: gp + 40, flexDirection: 'column', alignItems: 'center', padding: 20 }} uiBackground={{ color: Color4.create(0.12, 0.15, 0.2, 1) }}>
        <Label value={`${word.length} letters`} fontSize={16} color={GOLD} uiTransform={{ width: '100%', height: 22 }} />
        {/* Overlay whatever's been typed so far onto the dashes — shows
        exactly what you typed at each position, right or wrong; SUBMIT is
        still the only thing that checks correctness. */}
        <Label
          value={word.split('').map((_, i) => (typed[i] ? typed[i].toUpperCase() : '_')).join(' ')}
          fontSize={20}
          color={WHITE}
          uiTransform={{ width: '100%', height: 30 }}
        />

        {cells ? (
          <UiEntity uiTransform={{ width: gp, height: gp, flexDirection: 'column', margin: { top: 6 } }} uiBackground={{ color: Color4.White() }}>
            {rows}
          </UiEntity>
        ) : null}

        <Input
          placeholder="what is it?"
          // Only pass `value` during the one-frame clear pulse right after a
          // guess — passing `value=''` every OTHER frame too can fight what's
          // actually been typed on some platforms (Input is uncontrolled per
          // the SDK), making it look like nothing shows up while typing.
          {...(inputValue ? { value: inputValue } : {})}
          fontSize={16}
          // Text color matches the background — the dashes above already
          // show your typed letters live, so echoing raw text here too was
          // a second, differently-formatted view of the same guess.
          color={Color4.create(0.2, 0.24, 0.32, 1)}
          uiTransform={{ width: gp, height: 42, margin: { top: 10 } }}
          uiBackground={{ color: Color4.create(0.2, 0.24, 0.32, 1) }}
          onChange={(v) => (typed = v.slice(0, word.length))} // never allow more letters than the word has
          onSubmit={(v) => tryGuess((v || typed).slice(0, word.length))}
        />
        {feedback ? <Label value={feedback} fontSize={12} color={Color4.create(0.95, 0.6, 0.3, 1)} uiTransform={{ width: '100%', height: 18, margin: { top: 4 } }} /> : null}
        <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 12 } }}>
          {/* onMouseUp: a correct guess or CLOSE removes this whole
          full-screen `pointerFilter:'block'` modal — doing that on
          mouseDOWN swaps it away mid-touch, before the matching touch-up
          reaches anything, which can leave the explorer thinking a touch is
          still down and freeze movement afterward (see build-ui skill's
          pointer-capture gotcha). */}
          <Button value="SUBMIT" fontSize={14} uiTransform={{ width: 130, height: 40, margin: { right: 6 } }} color={WHITE} uiBackground={{ color: Color4.create(0.2, 0.5, 0.32, 1) }} onMouseUp={() => tryGuess(typed)} />
          <Button value="CLOSE" fontSize={14} uiTransform={{ width: 100, height: 40, margin: { left: 6 } }} color={WHITE} uiBackground={{ color: Color4.create(0.3, 0.32, 0.38, 1) }} onMouseUp={() => { play('click'); closeGuess() }} />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

function results() {
  const score = solvedCount()
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', pointerFilter: 'block' }}
      uiBackground={{ color: Color4.create(0, 0, 0, 0.75) }}
    >
      <UiEntity uiTransform={{ width: 380, flexDirection: 'column', alignItems: 'center', padding: 24 }} uiBackground={{ color: Color4.create(0.12, 0.15, 0.2, 1) }}>
        <Label value={remainingMs() === 0 ? "TIME'S UP" : 'ALL DONE'} fontSize={24} color={GOLD} uiTransform={{ width: '100%', height: 34 }} />
        <Label value={`${myName || 'You'} named ${score} / ${activeCount()}`} fontSize={16} color={WHITE} uiTransform={{ width: '100%', height: 28 }} />

        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', margin: { top: 12 } }}>
          <Label value="LEADERBOARD" fontSize={14} color={GOLD} uiTransform={{ width: '100%', height: 22 }} />
          {leaderboard.length === 0 ? (
            <Label value="posting your score…" fontSize={12} color={Color4.create(1, 1, 1, 0.6)} uiTransform={{ width: '100%', height: 20 }} />
          ) : (
            leaderboard.slice(0, 8).map((r, i) => {
              const mine = !!r.userId && r.userId === myUserId
              return (
                <UiEntity key={`${i}-${r.name}`} uiTransform={{ width: 280, height: 20, flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Label value={`${i + 1}. ${r.name}${mine ? '  (you)' : ''}`} fontSize={13} color={mine ? GOLD : WHITE} uiTransform={{ width: 220, height: 20 }} />
                  <Label value={`${r.correct}`} fontSize={13} color={GREEN} uiTransform={{ width: 40, height: 20 }} />
                </UiEntity>
              )
            })
          )}
        </UiEntity>

        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { top: 18 } }}>
          <Button value="PLAY AGAIN" fontSize={13} uiTransform={{ width: 140, height: 38, margin: { right: 6 } }} color={WHITE} uiBackground={{ color: Color4.create(0.2, 0.45, 0.7, 1) }} onMouseUp={() => { play('click'); startGuessRound() }} />
          <Button value="MENU" fontSize={13} uiTransform={{ width: 110, height: 38, margin: { left: 6 } }} color={WHITE} uiBackground={{ color: Color4.create(0.25, 0.27, 0.32, 1) }} onMouseUp={() => { play('click'); goMenu() }} />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

function clock(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${s % 60 < 10 ? '0' : ''}${s % 60}`
}
